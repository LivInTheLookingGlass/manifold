import { z } from 'zod'
import { APIError, newEndpoint, validate } from './api'
import { log } from './utils'
import { Contract, CPMMBinaryContract } from '../../common/contract'
import { User } from '../../common/user'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { removeUndefinedProps } from '../../common/util/object'
import { Acceptance, Challenge } from '../../common/challenge'
import { CandidateBet } from '../../common/new-bet'
import { getCpmmProbability } from '../../common/calculate-cpmm'
import { createChallengeAcceptedNotification } from './create-notification'

const bodySchema = z.object({
  contractId: z.string(),
  challengeSlug: z.string(),
})
const firestore = admin.firestore()

export const acceptchallenge = newEndpoint({}, async (req, auth) => {
  log('Inside endpoint handler.')
  const { challengeSlug, contractId } = validate(bodySchema, req.body)
  const result = await firestore.runTransaction(async (trans) => {
    log('Inside main transaction.')
    const contractDoc = firestore.doc(`contracts/${contractId}`)
    const userDoc = firestore.doc(`users/${auth.uid}`)
    const challengeDoc = firestore.doc(
      `contracts/${contractId}/challenges/${challengeSlug}`
    )
    const [contractSnap, userSnap, challengeSnap] = await trans.getAll(
      contractDoc,
      userDoc,
      challengeDoc
    )
    if (!contractSnap.exists) throw new APIError(400, 'Contract not found.')
    if (!userSnap.exists) throw new APIError(400, 'User not found.')
    if (!challengeSnap.exists) throw new APIError(400, 'Challenge not found.')
    log('Loaded user and contract snapshots.')

    const anyContract = contractSnap.data() as Contract
    const user = userSnap.data() as User
    const challenge = challengeSnap.data() as Challenge

    if (challenge.acceptances.length > 0)
      throw new APIError(400, 'Challenge already accepted.')

    const creatorDoc = firestore.doc(`users/${challenge.creatorId}`)
    const creatorSnap = await trans.get(creatorDoc)
    if (!creatorSnap.exists) throw new APIError(400, 'User not found.')
    const creator = creatorSnap.data() as User

    const { amount, yourOutcome, creatorsOutcome, creatorsOutcomeProb } =
      challenge
    if (user.balance < amount) throw new APIError(400, 'Insufficient balance.')

    const { closeTime, outcomeType } = anyContract
    if (closeTime && Date.now() > closeTime)
      throw new APIError(400, 'Trading is closed.')
    if (outcomeType !== 'BINARY')
      throw new APIError(400, 'Challenges only accepted for binary markets.')

    const contract = anyContract as CPMMBinaryContract
    const { YES: y, NO: n } = contract.pool
    const yourShares = (1 / (1 - creatorsOutcomeProb)) * amount
    const creatorShares = (1 / creatorsOutcomeProb) * amount

    const newYesShares = creatorsOutcome === 'YES' ? creatorShares : yourShares
    const newNoShares = creatorsOutcome === 'NO' ? creatorShares : yourShares
    const newPool = {
      YES: y + newYesShares,
      NO: n + newNoShares,
    }
    const probBefore = getCpmmProbability(contract.pool, contract.p)
    const probAfter = getCpmmProbability(newPool, contract.p)

    const yourNewBet: CandidateBet = removeUndefinedProps({
      orderAmount: amount,
      amount: amount,
      shares: yourShares,
      isCancelled: false,
      contractId: contract.id,
      outcome: yourOutcome,
      probBefore,
      probAfter,
      loanAmount: 0,
      createdTime: Date.now(),
      fees: { creatorFee: 0, platformFee: 0, liquidityFee: 0 },
    })
    const yourNewBetDoc = contractDoc.collection('bets').doc()
    trans.create(yourNewBetDoc, {
      id: yourNewBetDoc.id,
      userId: user.id,
      ...yourNewBet,
    })
    log('Created new bet document.')

    trans.update(userDoc, { balance: FieldValue.increment(-yourNewBet.amount) })
    log('Updated user balance.')

    const creatorNewBet: CandidateBet = removeUndefinedProps({
      orderAmount: amount,
      amount: amount,
      shares: creatorShares,
      isCancelled: false,
      contractId: contract.id,
      outcome: creatorsOutcome,
      probBefore,
      probAfter,
      loanAmount: 0,
      createdTime: Date.now(),
      fees: { creatorFee: 0, platformFee: 0, liquidityFee: 0 },
    })
    const creatorBetDoc = contractDoc.collection('bets').doc()
    trans.create(creatorBetDoc, {
      id: creatorBetDoc.id,
      userId: creator.id,
      ...creatorNewBet,
    })
    log('Created new bet document.')

    trans.update(creatorDoc, {
      balance: FieldValue.increment(-creatorNewBet.amount),
    })
    log('Updated user balance.')

    trans.update(
      contractDoc,
      removeUndefinedProps({
        pool: newPool,
        volume: contract.volume + yourNewBet.amount + creatorNewBet.amount,
      })
    )
    log('Updated contract properties.')

    trans.update(
      challengeDoc,
      removeUndefinedProps({
        acceptedByUserIds: [user.id],
        acceptances: [
          {
            userId: user.id,
            betId: yourNewBetDoc.id,
            createdTime: Date.now(),
            userUsername: user.username,
            userName: user.name,
            userAvatarUrl: user.avatarUrl,
          } as Acceptance,
        ],
      })
    )
    log('Updated challenge properties with new acceptance.')

    await createChallengeAcceptedNotification(
      user,
      creator,
      challenge,
      contract
    )
    log('Created notification.')
    return yourNewBetDoc
  })

  return { betId: result.id }
})