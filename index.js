import { createBundlerClient } from 'viem/account-abstraction'
import { arbitrumSepolia } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import fs from 'node:fs'
import { toEcdsaKernelSmartAccount } from 'permissionless/accounts'
import { hexToBigInt, encodeFunctionData, parseAbi, encodePacked, parseErc6492Signature, getContract, erc20Abi, formatUnits, createPublicClient, http } from 'viem'
import { eip2612Abi, eip2612Permit } from './permit-helpers.js'

async function tmp() {
    const client = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(),
      })
      
      const block = await client.getBlockNumber()
      console.log('Connected to network, latest block is', block)
    const PIMLICO_ENDPOINT = `https://public.pimlico.io/v2/${arbitrumSepolia.id}/rpc`
    const ARBITRUM_SEPOLIA_BUNDLER = `https://arb-sepolia.g.alchemy.com/v2/{}`

    const pimlicoClient = createBundlerClient({
      client,
      transport: http(PIMLICO_ENDPOINT),
    })

    const bundlerClient = createBundlerClient({
      client,
      transport: http(ARBITRUM_SEPOLIA_BUNDLER),
    })
    
    const owner = privateKeyToAccount(
        fs.existsSync('.owner_private_key')
          ? fs.readFileSync('.owner_private_key', 'utf8')
          : (() => {
              const privateKey = generatePrivateKey()
              fs.writeFileSync('.owner_private_key', privateKey)
              return privateKey
            })(),
      )
    
    
      const account = await toEcdsaKernelSmartAccount({
        client,
        owners: [owner],
        version: '0.3.1',
      })
      
      console.log('Owner address:', owner.address)
      console.log('Smart wallet address:', account.address)
    
    
      const ARBITRUM_SEPOLIA_USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'
    
      const usdc = getContract({
        client,
        address: ARBITRUM_SEPOLIA_USDC,
        abi: [...erc20Abi, ...eip2612Abi],
      })
      
      const usdcBalance = await usdc.read.balanceOf([account.address])
      
      if (usdcBalance === 0n) {
        console.log(
          'Visit https://faucet.circle.com/ to fund the smart wallet address above ' +
            '(not the owner address) with some USDC on Arbitrum Sepolia, ' +
            'then return here and run the script again.',
        )
        process.exit()
      } else {
        console.log(`Smart wallet has ${formatUnits(usdcBalance, 6)} USDC`)
      }
    
      const ARBITRUM_SEPOLIA_PAYMASTER = '0x31BE08D380A21fc740883c0BC434FcFc88740b58'
    
      // The max amount allowed to be paid per user op
      const MAX_GAS_USDC = 10000000n // 1 USDC
      
      console.log('Constructing and signing permit...')
      
      const permitData = await eip2612Permit({
        token: usdc,
        chain: arbitrumSepolia,
        ownerAddress: account.address,
        spenderAddress: ARBITRUM_SEPOLIA_PAYMASTER,
        value: MAX_GAS_USDC,
      })
      
      const wrappedPermitSignature = await account.signTypedData(permitData)
      const { signature: permitSignature } = parseErc6492Signature(
        wrappedPermitSignature,
      )
      
      console.log('Permit signature:', permitSignature)
    
      function sendUSDC(to, amount) {
        return {
          to: usdc.address,
          abi: usdc.abi,
          functionName: 'transfer',
          args: [to, amount],
        }
      }
      
      const recipient = privateKeyToAccount(generatePrivateKey()).address
      const calls = [sendUSDC(recipient, 10000n)] // $0.01 USDC
      
      const paymaster = ARBITRUM_SEPOLIA_PAYMASTER
      const paymasterData = encodePacked(
        ['uint8', 'address', 'uint256', 'bytes'],
        [
          0n, // Reserved for future use
          usdc.address, // Token address
          MAX_GAS_USDC, // Max spendable gas in USDC
          permitSignature, // EIP-2612 permit signature
        ],
      )
    
    
    const additionalGasCharge = hexToBigInt(
        (
          await client.call({
            to: paymaster,
            data: encodeFunctionData({
              abi: parseAbi(['function additionalGasCharge() returns (uint256)']),
              functionName: 'additionalGasCharge',
            }),
          })
        ).data,
      )
      
      console.log(
        'Additional gas charge (paymasterPostOpGasLimit):',
        additionalGasCharge,
      )
    
      const { standard: fees } = await pimlicoClient.request({
        method: 'pimlico_getUserOperationGasPrice',
      })
      
      const maxFeePerGas = hexToBigInt(fees.maxFeePerGas)
      const maxPriorityFeePerGas = hexToBigInt(fees.maxPriorityFeePerGas)
      
      console.log('Estimating user op gas limits...')
      
      const {
        callGasLimit,
        preVerificationGas,
        verificationGasLimit,
        paymasterPostOpGasLimit,
        paymasterVerificationGasLimit,
      } = await pimlicoClient.estimateUserOperationGas({
        account,
        calls,
        paymaster,
        paymasterData,
        // Make sure to pass in the `additionalGasCharge` from the paymaster
        paymasterPostOpGasLimit: additionalGasCharge,
        // Use very low gas fees for estimation to ensure successful permit/transfer,
        // since the bundler will simulate the user op with very high gas limits
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })
      
      console.log('Call gas limit:', callGasLimit)
      console.log('Pre-verification gas:', preVerificationGas)
      console.log('Verification gas limit:', verificationGasLimit)
      console.log('Paymaster post op gas limit:', paymasterPostOpGasLimit)
      console.log('Paymaster verification gas limit:', paymasterVerificationGasLimit)    

      console.log('Sending user op...')

      const userOpHash = await bundlerClient.sendUserOperation({
        account,
        calls,
        callGasLimit,
        preVerificationGas,
        verificationGasLimit,
        paymaster,
        paymasterData,
        paymasterVerificationGasLimit,
        // Make sure that `paymasterPostOpGasLimit` is always at least
        // `additionalGasCharge`, regardless of what the bundler estimated.
        paymasterPostOpGasLimit: Math.max(
          Number(paymasterPostOpGasLimit) || 0,
          Number(additionalGasCharge),
        ),
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      
      console.log('Submitted user op:', userOpHash)
      console.log('Waiting for execution...')
      
      const userOpReceipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash,
      })
      
      console.log('Done! Details:')
      console.log('  success:', userOpReceipt.success)
      console.log('  actualGasUsed:', userOpReceipt.actualGasUsed)
      console.log(
        '  actualGasCost:',
        formatUnits(userOpReceipt.actualGasCost, 18),
        'ETH',
      )
      console.log('  transaction hash:', userOpReceipt.receipt.transactionHash)
      console.log('  transaction gasUsed:', userOpReceipt.receipt.gasUsed)
      
      const usdcBalanceAfter = await usdc.read.balanceOf([account.address])
      const usdcConsumed = usdcBalance - usdcBalanceAfter - 10000n // Exclude what we sent
      
      console.log('  USDC paid:', formatUnits(usdcConsumed, 6))
      
      // We need to manually exit the process, since viem leaves some promises on the
      // event loop for features we're not using.
      process.exit()      
}  

(async () => {
    await tmp()
})()
