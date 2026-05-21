import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { saveDeployment, createCofheClient } from './utils'
import { Encryptable } from '@cofhe/sdk'

// Network-specific addresses
const NETWORK_ADDRESSES: Record<string, { aavePool?: string; usdc?: string; weth?: string; label: string }> = {
  'base-sepolia': {
    label: 'Base Sepolia',
    aavePool: '0x0789bb06c49FA5528F088b8a5dB49D201c47A644',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    weth: '0x4200000000000000000000000000000000000006',
  },
  'arb-sepolia': {
    label: 'Arbitrum Sepolia',
    aavePool: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    weth: '0x63605C3Eb0692E22D04A7F27F2B8D7AD6FE715E6',
  },
}

task('deploy-full-system', 'Deploy full vault system to any network')
  .addOptionalParam('asset', 'Address of ERC20 asset token (e.g., USDC)')
  .addOptionalParam('aavePool', 'Address of Aave V3 Pool contract')
  .addOptionalParam('name', 'Vault name', 'Cofhe Vault')
  .addOptionalParam('symbol', 'Vault symbol', 'cvToken')
  .addOptionalParam('recipient', 'Yield recipient address')
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre
    const [deployer] = await ethers.getSigners()

    console.log(`\n========================================`)
    console.log(`Deploying Full Vault System to ${network.name}`)
    console.log(`Deployer: ${deployer.address}`)
    console.log(`========================================\n`)

    // Resolve network addresses
    const netConfig = NETWORK_ADDRESSES[network.name]
    const assetAddr = args.asset || netConfig?.usdc
    const aavePoolAddr = args.aavePool || netConfig?.aavePool
    const recipientAddr = args.recipient || deployer.address

    if (!assetAddr) {
      throw new Error('No asset address provided. Use --asset flag or deploy on a supported network.')
    }

    // Helper: deploy and save
    const deployAndSave = async (name: string, factoryName: string, deployArgs: any[] = []) => {
      const Factory = await ethers.getContractFactory(factoryName)
      const contract = await Factory.connect(deployer).deploy(...deployArgs)
      await contract.waitForDeployment()
      const address = await contract.getAddress()
      saveDeployment(network.name, name, address)
      console.log(`  [OK] ${name}: ${address}`)
      return { contract, address }
    }

    // ===== Phase 1: Deploy Shared Infrastructure =====
    console.log('Phase 1: Deploying shared infrastructure...')

    const { address: vaultRegistryAddr } = await deployAndSave(
      'VaultRegistry', 'VaultRegistry'
    )

    const { address: mechanismFactoryAddr } = await deployAndSave(
      'AllocationMechanismFactory', 'AllocationMechanismFactory'
    )

    const { address: rebalancerAddr } = await deployAndSave(
      'PrivateRebalancer', 'PrivateRebalancer',
      [deployer.address] // factory = deployer for now
    )

    // ===== Phase 2: Deploy Vault Manually (bypass VaultFactory size limit) =====
    console.log('\nPhase 2: Deploying vault components...')

    // Create CoFHE client for encrypted inputs
    let encFee: any = [Buffer.from('')]
    let encDrift: any = [Buffer.from('')]
    let encMinTime: any = [Buffer.from('')]

    try {
      const client = await createCofheClient(hre, deployer)
      encFee = await client.encryptInputs([Encryptable.uint16(200n)]).execute()
      encDrift = await client.encryptInputs([Encryptable.uint16(500n)]).execute()
      encMinTime = await client.encryptInputs([Encryptable.uint32(86400n)]).execute()
      console.log('  [OK] CoFHE encryption available')
    } catch (e: any) {
      console.log(`  [WARN] CoFHE not available: ${e.message}. Using zero-initialized encrypted values.`)
      // Fallback: use zero bytes for encrypted inputs (owner can update later)
    }

    // 2a. Deploy PrivateComposableVault
    const VaultFactory = await ethers.getContractFactory('PrivateComposableVault')
    const vault = await VaultFactory.connect(deployer).deploy(
      assetAddr,
      args.name,
      args.symbol,
      deployer.address,  // owner
      deployer.address,  // keeper
      deployer.address,  // emergencyAdmin
      recipientAddr,     // donationAddress
      encFee[0]
    )
    await vault.waitForDeployment()
    const vaultAddr = await vault.getAddress()
    saveDeployment(network.name, 'PrivateComposableVault', vaultAddr)
    console.log(`  [OK] PrivateComposableVault: ${vaultAddr}`)

    // 2b. Deploy EncryptedStrategyRegistry
    const RegistryFactory = await ethers.getContractFactory('EncryptedStrategyRegistry')
    const registry = await RegistryFactory.connect(deployer).deploy(
      vaultAddr,
      deployer.address,
      10,              // maxStrategies
      deployer.address // factory
    )
    await registry.waitForDeployment()
    const registryAddr = await registry.getAddress()
    saveDeployment(network.name, 'EncryptedStrategyRegistry', registryAddr)
    console.log(`  [OK] EncryptedStrategyRegistry: ${registryAddr}`)

    // 2c. Deploy FixedAllocationMechanism
    const FAMFactory = await ethers.getContractFactory('FixedAllocationMechanism')
    const mechanism = await FAMFactory.connect(deployer).deploy(
      deployer.address,
      [recipientAddr],
      [10000n] // 100% to recipient
    )
    await mechanism.waitForDeployment()
    const mechanismAddr = await mechanism.getAddress()
    saveDeployment(network.name, 'FixedAllocationMechanism', mechanismAddr)
    console.log(`  [OK] FixedAllocationMechanism: ${mechanismAddr}`)

    // 2d. Deploy YieldRouter
    const YRFactory = await ethers.getContractFactory('YieldRouter')
    const yieldRouter = await YRFactory.connect(deployer).deploy(vaultAddr, mechanismAddr)
    await yieldRouter.waitForDeployment()
    const yieldRouterAddr = await yieldRouter.getAddress()
    saveDeployment(network.name, 'YieldRouter', yieldRouterAddr)
    console.log(`  [OK] YieldRouter: ${yieldRouterAddr}`)

    // 2e. Deploy SelectiveDisclosureModule
    const SDMFactory = await ethers.getContractFactory('SelectiveDisclosureModule')
    const sdm = await SDMFactory.connect(deployer).deploy(vaultAddr, registryAddr)
    await sdm.waitForDeployment()
    const sdmAddr = await sdm.getAddress()
    saveDeployment(network.name, 'SelectiveDisclosureModule', sdmAddr)
    console.log(`  [OK] SelectiveDisclosureModule: ${sdmAddr}`)

    // 2f. Initialize vault
    console.log('\nPhase 3: Initializing vault...')
    await vault.connect(deployer).initialize(registryAddr, yieldRouterAddr, rebalancerAddr)
    console.log('  [OK] Vault initialized')

    // 2g. Link rebalancer in registry
    await registry.connect(deployer).setRebalancer(rebalancerAddr)
    console.log('  [OK] Rebalancer linked to registry')

    // 2h. Configure rebalancer
    try {
      const RebalancerFactory = await ethers.getContractFactory('PrivateRebalancer')
      const rebalancer = RebalancerFactory.attach(rebalancerAddr)
      await rebalancer.connect(deployer).configureVault(vaultAddr, encDrift[0], encMinTime[0])
      console.log('  [OK] Rebalancer configured')
    } catch (e: any) {
      console.log(`  [WARN] Could not configure rebalancer: ${e.message}`)
    }

    // 2i. Register vault in VaultRegistry
    const VaultRegistryFactory = await ethers.getContractFactory('VaultRegistry')
    const vaultRegistry = VaultRegistryFactory.attach(vaultRegistryAddr)
    await vaultRegistry.connect(deployer).register(
      vaultAddr,
      assetAddr,
      args.name,
      args.symbol,
      deployer.address
    )
    console.log('  [OK] Vault registered in VaultRegistry')

    // ===== Phase 3: Deploy Aave Strategy (if pool address provided) =====
    if (aavePoolAddr) {
      console.log('\nPhase 4: Deploying Aave V3 YDS Strategy...')

      const AaveStrategyFactory = await ethers.getContractFactory('AaveV3YDSStrategy')
      const aaveStrategy = await AaveStrategyFactory.connect(deployer).deploy(
        assetAddr,
        vaultAddr,
        deployer.address,  // management
        deployer.address,  // keeper
        deployer.address,  // emergencyAdmin
        aavePoolAddr
      )
      await aaveStrategy.waitForDeployment()
      const aaveStrategyAddr = await aaveStrategy.getAddress()
      saveDeployment(network.name, 'AaveV3YDSStrategy', aaveStrategyAddr)
      console.log(`  [OK] AaveV3YDSStrategy: ${aaveStrategyAddr}`)

      // Register strategy in registry and vault
      try {
        const encWeight = await (async () => {
          try {
            const client = await createCofheClient(hre, deployer)
            const enc = await client.encryptInputs([Encryptable.uint16(10000n)]).execute()
            return enc[0]
          } catch {
            return encDrift[0] // reuse existing encrypted input
          }
        })()

        await registry.connect(deployer).addStrategy(aaveStrategyAddr, encWeight)
        await vault.connect(deployer).addStrategy(aaveStrategyAddr)
        console.log('  [OK] Strategy registered in registry and vault')
      } catch (e: any) {
        console.log(`  [WARN] Could not register strategy: ${e.message}`)
      }
    }

    // ===== Summary =====
    console.log('\n========================================')
    console.log('Deployment Summary')
    console.log('========================================')
    console.log(`Network:     ${network.name}`)
    console.log(`Deployer:    ${deployer.address}`)
    console.log(`Asset:       ${assetAddr}`)
    console.log(`Vault:       ${vaultAddr}`)
    console.log(`Registry:    ${registryAddr}`)
    console.log(`Rebalancer:  ${rebalancerAddr}`)
    console.log(`Router:      ${yieldRouterAddr}`)
    console.log(`Disclosure:  ${sdmAddr}`)
    console.log(`Mechanism:   ${mechanismAddr}`)
    console.log(`Infra Reg:   ${vaultRegistryAddr}`)
    console.log(`Mech Factory:${mechanismFactoryAddr}`)
    if (aavePoolAddr) {
      console.log(`Aave Pool:   ${aavePoolAddr}`)
      const aaveStrat = await ethers.getContractAt('AaveV3YDSStrategy', (await ethers.provider.getStorage(vaultAddr, 0)) || '0x')
      // We saved it above
    }
    console.log(`\nDeployment info saved to deployments/${network.name}.json`)
    console.log('========================================\n')
  })
