import { formatsByCoinType } from '@ensdomains/address-encoder'
import { ethers } from 'ethers'
import { InternalENS } from '.'
import { hexEncodeName } from './utils/hexEncodedName'

type InternalProfileOptions = {
  contentHash?: boolean | string
  texts?: string[]
  coinTypes?: string[]
}

type ProfileResponse = {
  contentHash?: string
  texts?: string[]
  coinTypes?: string[]
}

type DataItem = {
  key: string | number
  type: 'addr' | 'text' | 'contentHash'
  coin?: string
  value: string
}

const getDataForName = async (
  ENS: InternalENS,
  name: string,
  options: InternalProfileOptions,
) => {
  const publicResolver = await ENS.contracts?.getPublicResolver()
  const universalResolver = await ENS.contracts?.getUniversalResolver()

  let calls: any[] = []

  const encodeData = (sig: string, ...args: any[]) =>
    publicResolver.interface.encodeFunctionData(sig, [...args])

  const addCalls = (
    recordArray: string[],
    recordType: string,
    functionArgs: string,
    name: string,
    ...args: any[]
  ) =>
    recordArray.forEach((item: string) =>
      calls.push({
        key: item,
        data: encodeData(
          recordType + functionArgs,
          ethers.utils.namehash(name),
          item,
          ...args,
        ),
        type: recordType,
      }),
    )

  options.texts && addCalls(options.texts, 'text', '(bytes32,string)', name)
  options.coinTypes &&
    addCalls(options.coinTypes, 'addr', '(bytes32,uint256)', name)
  if (typeof options.contentHash === 'boolean' && options.contentHash) {
    calls.push({
      key: 'contentHash',
      data: encodeData('contenthash(bytes32)', name),
      type: 'contenthash',
    })
  }

  if (!calls.filter((x) => x.key === '60')) {
    calls.push({
      key: '60',
      data: encodeData('addr(bytes32,uint256)', name, '60'),
      type: 'addr',
    })
  }

  const data = publicResolver.interface.encodeFunctionData(
    'multicall(bytes[])',
    [calls.map((call: any) => call.data)],
  )

  const resolver = await universalResolver.resolve(hexEncodeName(name), data)
  const [recordData] = ethers.utils.defaultAbiCoder.decode(
    ['bytes[]'],
    resolver,
  )

  return {
    address: ethers.utils.defaultAbiCoder.decode(
      ['bytes'],
      recordData[calls.findIndex((x) => x.key === '60')],
    )[0],
    records: formatRecords(recordData, calls, options),
  }
}

const getDataForAddress = async (
  ENS: InternalENS,
  address: string,
  options: InternalProfileOptions,
) => {
  const universalResolver = await ENS.contracts?.getUniversalResolver()

  const reverseNode = address.toLowerCase().substring(2) + '.addr.reverse'

  const makeResolverData = (sig: string, dataType?: string, data?: any) => ({
    sig,
    data:
      dataType && data
        ? [
            {
              dataType,
              data: ethers.utils.defaultAbiCoder.encode([dataType], [data]),
            },
          ]
        : [],
  })

  const addCalls = (
    keyArray: string[],
    callArray: any[],
    type: string,
    callArgs: string,
  ) =>
    keyArray.forEach((item: string) =>
      callArray.push({
        key: item,
        data: makeResolverData(
          type + callArgs,
          callArgs.split(',')[0].replace(')', ''),
          item,
        ),
        type,
      }),
    )

  let calls: any[] = []
  options.texts && addCalls(options.texts, calls, 'text', '(bytes32,string)')
  options.coinTypes &&
    addCalls(options.coinTypes, calls, 'addr', '(bytes32,uint256)')
  if (typeof options.contentHash === 'boolean' && options.contentHash) {
    calls.push({
      key: 'contentHash',
      data: makeResolverData('contenthash(bytes32)'),
      type: 'contenthash',
    })
  }

  if (!calls.filter((x) => x.key === '60')) {
    calls.push({
      key: '60',
      data: makeResolverData('addr(bytes32,uint256)', 'uint256', '60'),
      type: 'addr',
    })
  }

  const result = await universalResolver.reverse(
    hexEncodeName(reverseNode),
    calls.map((call: any) => call.data),
  )
  const name = result['0']
  const data = result['1']
  if (
    ethers.utils.defaultAbiCoder.decode(
      ['bytes'],
      data[calls.findIndex((x) => x.key === '60')],
    )[0] !== address.toLowerCase()
  ) {
    return { name, records: null, match: false }
  }
  return { name, records: formatRecords(data, calls, options), match: true }
}

const formatRecords = (
  data: any[],
  calls: any[],
  options: InternalProfileOptions,
) => {
  let returnedRecords: DataItem[] = data
    .map((item: string, i: number) => {
      let decodedFromAbi: any
      let itemRet: Record<string, any> = {
        key: calls[i].key,
        type: calls[i].type,
      }
      if (itemRet.type === 'addr' || itemRet.type === 'contenthash') {
        decodedFromAbi = ethers.utils.defaultAbiCoder.decode(['bytes'], item)[0]
        if (ethers.utils.hexStripZeros(decodedFromAbi) === '0x') {
          return null
        }
      }
      switch (calls[i].type) {
        case 'text':
          itemRet = {
            ...itemRet,
            value: ethers.utils.defaultAbiCoder.decode(['string'], item)[0],
          }
          if (itemRet.value === '') return null
          break
        case 'addr':
          const format = formatsByCoinType[calls[i].key]
          if (format) {
            itemRet = {
              ...itemRet,
              coin: format.name,
              value: format.encoder(
                Buffer.from(decodedFromAbi.slice(2), 'hex'),
              ),
            }
            break
          } else {
            return null
          }
        case 'contenthash':
          itemRet = { ...itemRet, value: decodedFromAbi }
          break
      }
      return itemRet
    })
    .filter((x): x is DataItem => {
      return typeof x === 'object'
    })
    .filter((x) => x !== null)

  let returnedResponse: {
    contentHash?: string | null
    coinTypes?: DataItem[]
    texts?: DataItem[]
  } = {}

  if (typeof options.contentHash === 'string') {
    if (ethers.utils.hexStripZeros(options.contentHash) === '0x') {
      returnedResponse.contentHash = null
    } else {
      returnedResponse.contentHash = options.contentHash
    }
  } else if (options.contentHash) {
    const foundRecord = returnedRecords.find(
      (item: any) => item.type === 'contenthash',
    )
    returnedResponse.contentHash = foundRecord ? foundRecord.value : null
  }
  if (options.texts) {
    returnedResponse.texts = returnedRecords.filter(
      (x: any) => x.type === 'text',
    )
  }
  if (options.coinTypes) {
    returnedResponse.coinTypes = returnedRecords.filter(
      (x: any) => x.type === 'addr',
    )
  }
  return returnedResponse
}

const graphFetch = async (
  ENS: InternalENS,
  name: string,
  wantedRecords: ProfileOptions,
) => {
  const query = ENS.gqlInstance.gql`
    query getRecords($name: String!) {
      domains(where: { name: $name }) {
        resolver {
          texts
          coinTypes
          contentHash
          addr {
            id
          }
        }
      }
    }
  `

  const client = ENS.gqlInstance.client

  const {
    domains: [{ resolver: resolverResponse }],
  } = await client.request(query, { name })

  Object.keys(wantedRecords).forEach((key: string) => {
    const data = wantedRecords[key as keyof ProfileOptions]
    if (typeof data === 'boolean' && data) {
      wantedRecords[key as keyof ProfileOptions] = resolverResponse[key]
    }
  })

  return wantedRecords as ProfileResponse
}

type ProfileOptions = {
  contentHash?: boolean
  texts?: boolean | string[]
  coinTypes?: boolean | string[]
}

const getProfileFromAddress = async (
  ENS: InternalENS,
  address: string,
  options?: ProfileOptions,
) => {
  if (
    !options ||
    (options && options.texts === true) ||
    options.coinTypes === true
  ) {
    const name = await ENS.getName(address)
    if (!name.match) return { name, records: null, match: false }
    const wantedRecords = await graphFetch(
      ENS,
      name.name,
      options || { contentHash: true, texts: true, coinTypes: true },
    )
    const { records } = await getDataForName(ENS, name.name, wantedRecords)
    return { name: name.name, records, match: true }
  } else {
    return await getDataForAddress(
      ENS,
      address,
      options as InternalProfileOptions,
    )
  }
}

const getProfileFromName = async (
  ENS: InternalENS,
  name: string,
  options?: ProfileOptions,
) => {
  if (
    !options ||
    (options && options.texts === true) ||
    options.coinTypes === true
  ) {
    const wantedRecords = await graphFetch(
      ENS,
      name,
      options || { contentHash: true, texts: true, coinTypes: true },
    )
    const { records, address } = await getDataForName(ENS, name, wantedRecords)
    return { address, records }
  } else {
    return await getDataForName(ENS, name, options as InternalProfileOptions)
  }
}

export default async function (
  this: InternalENS,
  nameOrAddress: string,
  options?: ProfileOptions,
) {
  if (nameOrAddress.includes('.')) {
    return getProfileFromName(this, nameOrAddress, options)
  } else {
    return getProfileFromAddress(this, nameOrAddress, options)
  }
}
