import {
  calculateLPCost,
  fromProb,
  getSwap3Probability,
  noShares,
  Swap3Pool,
  yesShares,
} from 'common/calculate-swap3'
import { formatPercent } from 'common/util/format'
import { useState } from 'react'
import { LiquidityGraph } from 'web/components/contract/liquidity-graph'
import { Col } from 'web/components/layout/col'
import { Row } from 'web/components/layout/row'

const users = {
  alice: {
    M: 100,
    YES: 0,
    NO: 0,
  },
  bob: {
    M: 200,
    YES: 0,
    NO: 0,
  },
  kipply: {
    M: 300,
    YES: 0,
    NO: 0,
  },
}

function BalanceTable() {
  /* Display all users current M, YES, and NO in a table */
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className="px-4 py-2">User</th>
          <th className="px-4 py-2">M</th>
          <th className="px-4 py-2">YES</th>
          <th className="px-4 py-2">NO</th>
        </tr>
      </thead>
      <tbody>
        {Object.keys(users).map((user) => (
          <tr key={user}>
            <td className="px-4 py-2">{user}</td>
            <td className="px-4 py-2">{users[user].M}</td>
            <td className="px-4 py-2">{users[user].YES}</td>
            <td className="px-4 py-2">{users[user].NO}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* Show the values in pool */
function PoolTable(props: { pool: Swap3Pool }) {
  const { pool } = props
  return (
    <Row className="gap-4">
      <div>
        <label>Liquidity: </label>
        {pool.liquidity}
      </div>
      <div>
        <label>Tick: </label>
        {pool.tick}
      </div>
      <div>
        <label>Pool YES: </label>
        {yesShares(pool).toFixed(2)}
      </div>
      <div>
        <label>Pool NO: </label>
        {noShares(pool).toFixed(2)}
      </div>
      <div>
        <label>Implied: </label>
        {formatPercent(getSwap3Probability(pool))}
      </div>
    </Row>
  )
}

function Graph(props: { pool: Swap3Pool }) {
  const points = [
    { x: 0, y: 100 },
    { x: 0.2, y: 100 },
    { x: 0.2, y: 200 },
    { x: 0.33, y: 200 },
    { x: 0.33, y: 100 },
    { x: 1, y: 100 },
  ]
  return <LiquidityGraph points={points} />
}

export default function Swap() {
  const [pool, setPool] = useState({
    liquidity: 100,
    tick: fromProb(0.3),
    tickStates: [],
  })

  const [minTick, setMinTick] = useState(0)
  const [maxTick, setMaxTick] = useState(0)

  const { requiredN, requiredY } = calculateLPCost(
    pool.tick,
    minTick,
    maxTick,
    100 // deltaL
  )

  return (
    <Col className="mx-auto max-w-2xl gap-20 p-4">
      {/* <BalanceTable /> */}
      <PoolTable pool={pool} />
      <Graph pool={pool} />
      <input
        className="input"
        placeholder="Current%"
        type="number"
        onChange={(e) =>
          setPool((p) => ({
            ...p,
            tick: inputPercentToTick(e),
          }))
        }
      />

      <Col>
        Alice: Add liquidity
        <input className="input" placeholder="Amount" type="number" />
        <input
          className="input"
          placeholder="Min%"
          type="number"
          onChange={(e) => setMinTick(inputPercentToTick(e))}
        />
        Min Tick: {minTick}
        <input
          className="input"
          placeholder="Max%"
          type="number"
          onChange={(e) => setMaxTick(inputPercentToTick(e))}
        />
        Max Tick: {maxTick}
        <Row className="gap-2 py-2">
          <div>Y required: {requiredY}</div>
          <div>N required: {requiredN}</div>{' '}
        </Row>
        <button className="btn">Create pool</button>
      </Col>

      <Col>
        Bob: Buy Tokens
        {/* <input className="input" placeholder="User" type="text" /> */}
        <input className="input" placeholder="Amount" type="number" />
        <Row className="gap-2">
          <button className="btn">Buy YES</button>
          <button className="btn">Buy NO</button>
        </Row>
      </Col>
    </Col>
  )
}

function inputPercentToTick(event: React.ChangeEvent<HTMLInputElement>) {
  return fromProb(parseFloat(event.target.value) / 100)
}
