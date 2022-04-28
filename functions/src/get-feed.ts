import * as _ from 'lodash'
import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

import { getValue, getValues } from './utils'
import { Contract } from '../../common/contract'
import { logInterpolation } from '../../common/util/math'
import { DAY_MS } from '../../common/util/time'
import {
  getProbability,
  getOutcomeProbability,
  getTopAnswer,
} from '../../common/calculate'
import { Bet } from '../../common/bet'
import { Comment } from '../../common/comment'

const firestore = admin.firestore()

const MAX_FEED_CONTRACTS = 60

export const getFeed = functions
  .runWith({ minInstances: 1 })
  .https.onCall(async (_data, context) => {
    const userId = context?.auth?.uid
    if (!userId) return { status: 'error', message: 'Not authorized' }

    // Get contracts bet on or created in last week.
    const contractsPromise = Promise.all([
      getValues<Contract>(
        firestore
          .collection('contracts')
          .where('isResolved', '==', false)
          .where('volume7Days', '>', 0)
      ),

      getValues<Contract>(
        firestore
          .collection('contracts')
          .where('isResolved', '==', false)
          .where('createdTime', '>', Date.now() - DAY_MS * 7)
          .where('volume7Days', '==', 0)
      ),
    ]).then(([activeContracts, inactiveContracts]) => {
      const combined = [...activeContracts, ...inactiveContracts]
      // Remove closed contracts.
      return combined.filter((c) => (c.closeTime ?? Infinity) > Date.now())
    })

    const userCacheCollection = firestore.collection(
      `private-users/${userId}/cached`
    )
    const [recommendationScores, lastViewedTime] = await Promise.all([
      getValue<{ [contractId: string]: number }>(
        userCacheCollection.doc('contractScores')
      ),
      getValue<{ [contractId: string]: number }>(
        userCacheCollection.doc('lastViewTime')
      ),
    ]).then((dicts) => dicts.map((dict) => dict ?? {}))

    const contracts = await contractsPromise

    const averageRecScore =
      1 +
      _.sumBy(
        contracts.filter((c) => recommendationScores[c.id] !== undefined),
        (c) => recommendationScores[c.id]
      ) /
        (contracts.length + 1)

    console.log({ recommendationScores, averageRecScore, lastViewedTime })

    const scoredContracts = contracts.map((contract) => {
      const score = scoreContract(
        contract,
        recommendationScores[contract.id] ?? averageRecScore,
        lastViewedTime[contract.id]
      )
      return [contract, score] as [Contract, number]
    })

    const sortedContracts = _.sortBy(
      scoredContracts,
      ([_, score]) => score
    ).reverse()

    console.log(sortedContracts.map(([c, score]) => c.question + ': ' + score))

    const feedContracts = sortedContracts
      .slice(0, MAX_FEED_CONTRACTS)
      .map(([c]) => c)

    const feed = await Promise.all(
      feedContracts.map((contract) => getRecentBetsAndComments(contract))
    )

    console.log('feed', feed)

    return { status: 'success', feed }
  })

function scoreContract(
  contract: Contract,
  recommendationScore: number,
  viewTime: number | undefined
) {
  const lastViewedScore = getLastViewedScore(viewTime)
  const activityScore = getActivityScore(contract, viewTime)
  return recommendationScore * lastViewedScore * activityScore
}

function getActivityScore(contract: Contract, viewTime: number | undefined) {
  const { createdTime, lastBetTime, lastCommentTime, outcomeType } = contract
  const hasNewComments =
    lastCommentTime && (!viewTime || lastCommentTime > viewTime)
  const newCommentScore = hasNewComments ? 1 : 0.5

  const timeSinceLastBet = Date.now() - (lastBetTime ?? createdTime)
  const daysAgo = timeSinceLastBet / DAY_MS
  const betTimeScore = 1 - logInterpolation(0, 3, daysAgo)

  let prob = 0.5
  if (outcomeType === 'BINARY') {
    prob = getProbability(contract)
  } else if (outcomeType === 'FREE_RESPONSE') {
    const topAnswer = getTopAnswer(contract)
    if (topAnswer)
      prob = Math.max(0.5, getOutcomeProbability(contract, topAnswer.id))
  }
  const frac = 1 - Math.abs(prob - 0.5) ** 2 / 0.25
  const probScore = 0.5 + frac * 0.5

  const { volume24Hours, volume7Days, volume } = contract
  const combinedVolume =
    Math.log(volume24Hours + 1) +
    Math.log(volume7Days + 1) +
    Math.log(volume + 1)
  const volumeScore = 0.5 + 0.5 * logInterpolation(7, 35, combinedVolume)

  const score = newCommentScore * betTimeScore * probScore * volumeScore

  // Map score to [0.5, 1] since no recent activty is not a deal breaker.
  const mappedScore = 0.5 + 0.5 * score
  const newMappedScore = 0.7 + 0.3 * score

  const isNew = Date.now() < contract.createdTime + DAY_MS
  return isNew ? newMappedScore : mappedScore
}

function getLastViewedScore(viewTime: number | undefined) {
  if (viewTime === undefined) {
    return 1
  }

  const daysAgo = (Date.now() - viewTime) / DAY_MS

  if (daysAgo < 0.5) {
    const frac = logInterpolation(0, 0.5, daysAgo)
    return 0.5 * frac
  }

  const frac = logInterpolation(0.5, 14, daysAgo)
  return 0.5 + 0.5 * frac
}

async function getRecentBetsAndComments(contract: Contract) {
  const contractDoc = firestore.collection('contracts').doc(contract.id)

  const [recentBets, recentComments] = await Promise.all([
    getValues<Bet>(
      contractDoc
        .collection('bets')
        .where('createdTime', '>', Date.now() - DAY_MS)
    ),

    getValues<Comment>(
      contractDoc
        .collection('comments')
        .where('createdTime', '>', Date.now() - 3 * DAY_MS)
    ),
  ])

  return {
    contract,
    recentBets,
    recentComments,
  }
}
