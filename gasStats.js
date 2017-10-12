/**
 * Methods to generate gas data.
 */

const colors = require('colors')
const _ = require('lodash')
const path = require('path')
const request = require('request-promise-native')
const shell = require('shelljs')
const Table = require('cli-table2')
const reqCwd = require('req-cwd')
const abiDecoder = require('abi-decoder')

/**
 * Expresses gas usage as a nation-state currency price
 * @param  {Number} gas      gas used
 * @param  {Number} ethPrice e.g chf/eth
 * @param  {Number} gasPrice in wei e.g 5000000000 (5 gwei)
 * @return {Number}          cost of gas used (0.00)
 */
function gasToCost (gas, ethPrice, gasPrice) {
  return ((gasPrice / 1e18) * gas * ethPrice).toFixed(2)
}

/**
 * Expresses gas usage as a % of the block gasLimit. Source: NeuFund (see issues)
 * @param  {Number} gasUsed    gas value
 * @param  {Number} blockLimit gas limit of a block
 * @return {Number}            percent (0.0)
 */
function gasToPercentOfLimit(gasUsed, blockLimit = 6718946){
  return Math.round(1000 * gasUsed / blockLimit) / 10;
}

/**
 * Extracts the method identifier from the input field of obj returned by web3.eth.getTransaction
 * @param  {String} code hex data
 * @return {String}      method identifier (used by abi-decoder)
 */
function getMethodID (code) {
  return code.slice(2, 10)
}

/**
 * Prints a gas stats table to stdout. Source: Gnosis / Alan Lu (see issues)
 * @param  {Object} methodMap methods and their gas usage (from mapMethodToContracts)
 */
async function generateGasStatsReport (methodMap) {
  const {
    currency,
    ethPrice,
    gasPrice
  } = await getGasAndPriceRates()

  const table = new Table({style:{head:[], border:[]}});
  const title = [{hAlign: 'center', colSpan: 6, content: '✜✜✜✜✜   GAS STATS  ✜✜✜✜✜'.rainbow.bold,}]
  const header = [
      'Contract'.bold,
      'Method'.bold,
      'Min'.green,
      'Max'.green,
      'Avg'.green,
      `${currency.toUpperCase()} (avg)`.bold
    ]

  table.push(title);
  table.push(header);

  _.forEach(methodMap, (data, methodId) => {
    if (!data) return

    let stats = {};

    stats.average = data.gasData.reduce((acc, datum) => acc + datum, 0) / data.gasData.length
    stats.cost = (ethPrice && gasPrice) ? gasToCost(stats.average, ethPrice, gasPrice) : '-'.grey

    const sortedData = data.gasData.sort();
    stats.min = sortedData[0]
    stats.max = sortedData[sortedData.length - 1]

    const uniform = (stats.min === stats.max);
    stats.min = (uniform) ? '-'.yellow : stats.min;
    stats.max = (uniform) ? '-'.red : stats.max;

    section = [];
    section.push(data.contract.grey);
    section.push(data.method)
    section.push(stats.min)
    section.push(stats.max)
    section.push(stats.average.toString().grey)
    section.push({hAlign: 'right', content: stats.cost.toString()})

    table.push(section)
  })
  console.log(table.toString())
}

/**
 * Async method that fetches gasPrices from blockcypher.com (default to the lowest safe
 * gas price) and current market value of eth in currency specified by the config from
 * coinmarketcap (defaults to euros).
 * @return {Object}
 * @example
 *   const {
 *     currency, // 'eur'
 *     gasPrice, // '5000000000'
 *     ethPrice, // '212.02'
 *   } = await getGasAndPriceRates()
 *
 */
async function getGasAndPriceRates () {
  let ethPrice
  let gasPrice
  const defaultGasPrice = 5000000000

  // Load config
  const config = reqCwd.silent('.ethgas.js') || {}
  const currency = config.currency || 'eur'

  ethPrice = config.ethPrice || null
  gasPrice = config.gasPrice || null

  const currencyPath = `https://api.coinmarketcap.com/v1/ticker/ethereum/?convert=${currency.toUpperCase()}`
  const currencyKey = `price_${currency.toLowerCase()}`
  const gasPricePath = `https://api.blockcypher.com/v1/eth/main`

  // Currency market data: coinmarketcap
  if (!ethPrice) {
    try {
      let response = await request.get(currencyPath)
      response = JSON.parse(response)
      ethPrice = response[0][currencyKey]
    } catch (error) {
      ethPrice = null
    }
  }

  // Gas price data: blockcypher
  if (!gasPrice) {
    try {
      let response = await request.get(gasPricePath)
      response = JSON.parse(response)
      gasPrice = response['low_gas_price']
    } catch (error) {
      gasPrice = defaultGasPrice
    }
  }

  return {
    currency: currency,
    ethPrice: ethPrice,
    gasPrice: gasPrice
  }
}

/**
 * Generates a complete mapping of method data ids to their contract and method names.
 * Map also initialised w/ an empty `gasData` array that the gas value of each matched transaction
 * is pushed to. Expects a`contracts` folder in the cwd.
 * @param  {Object} truffleArtifacts the `artifacts` of `artifacts.require('MetaCoin.sol')
 * @return {Object}                  mapping
 * @example output
 *   {
 *    "90b98a11": {
 *     "contract": "MetaCoin",
 *     "method": "sendCoin",
 *     "gasData": []
 *    },
 *   }
 */
function mapMethodsToContracts (truffleArtifacts) {
  const methodMap = {}
  const abis = []

  const names = shell.ls('./contracts/**/*.sol')
  names.sort();

  names.forEach(name => {
    name = path.basename(name);

    if (name === 'Migrations.sol') return

    // Load all the artifacts
    const contract = truffleArtifacts.require(name)
    abis.push(contract._json.abi)

    // Decode, getMethodIDs
    abiDecoder.addABI(contract._json.abi)
    const methodIDs = abiDecoder.getMethodIDs()

    // Create Map;
    Object.keys(methodIDs).forEach(key => {
      const isConstant = methodIDs[key].constant
      const isEvent = methodIDs[key].type === 'event'
      const hasName = methodIDs[key].name

      if (hasName && !isConstant && !isEvent){
        methodMap[key] = {
          contract: name.split('.sol')[0],
          method: methodIDs[key].name,
          gasData: []
        }
      }
    })
    abiDecoder.removeABI(contract._json.abi)
  })

  abis.forEach(abi => abiDecoder.addABI(abi))
  return methodMap
}

// Debugging helper
function pretty (msg, obj) {
  console.log(`<------ ${msg} ------>\n` + JSON.stringify(obj, null, ' '))
  console.log(`<------- END -------->\n`)
}

module.exports = {
  mapMethodsToContracts: mapMethodsToContracts,
  getMethodID: getMethodID,
  getGasAndPriceRates: getGasAndPriceRates,
  gasToPercentOfLimit: gasToPercentOfLimit,
  generateGasStatsReport: generateGasStatsReport,
  pretty: pretty
}


