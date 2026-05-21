import hre from "hardhat";
import { expect } from "chai";
import { parseUnits, formatUnits } from "ethers";

// Testnet addresses for Aave V3
const NETWORKS: Record<string, { pool: string; usdc: string; whale: string; name: string }> = {
  "base-sepolia": {
    pool: "0x1401bf602d95a0d52978961644b7bdd117cf6df6",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    whale: "0xd152f549436f7f690fb5b465474e8Ce64e1b47a9",
    name: "Base Sepolia",
  },
  "arb-sepolia": {
    pool: "0x14496b405d62c24f91f04cda1c69dc526d56fde5",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    whale: "0x55FE002aefF02F77364de339a1292923A15844B8",
    name: "Arbitrum Sepolia",
  },
  "eth-mainnet": {
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    whale: "0x55FE002aefF02F77364de339a1292923A15844B8",
    name: "Ethereum Mainnet",
  },
};

const DEPOSIT_AMOUNT = 100_000n * 10n ** 6n; // 100k USDC

const forkNetwork = process.env.FORK_NETWORK || "";
const networkConfig = NETWORKS[forkNetwork];

if (!networkConfig) {
  console.log(`Skipping testnet fork tests — set FORK_NETWORK=base-sepolia|arb-sepolia|eth-mainnet`);
}

const describeTestnet = networkConfig ? describe : describe.skip;

describeTestnet(`AaveV3YDSStrategy — ${networkConfig?.name} Fork`, function () {
  this.timeout(120000);

  let deployer: any;
  let whale: any;
  let strategy: any;
  let usdc: any;
  let cfg: { pool: string; usdc: string; whale: string; name: string };

  cfg = NETWORKS[forkNetwork];

  async function setupFork() {
    [deployer] = await hre.ethers.getSigners();

    // Fund deployer with ETH for gas
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [deployer.address, "0x" + parseUnits("100", 18).toString(16)],
    });

    // Impersonate USDC whale
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [cfg.whale],
    });
    whale = await hre.ethers.getSigner(cfg.whale);

    // Give whale ETH for gas
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [cfg.whale, "0x" + parseUnits("10", 18).toString(16)],
    });

    // Get USDC contract
    usdc = await hre.ethers.getContractAt(
      "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
      cfg.usdc
    );

    // Deploy strategy
    const StrategyFactory = await hre.ethers.getContractFactory("AaveV3YDSStrategy");
    strategy = await StrategyFactory.connect(deployer).deploy(
      cfg.usdc,
      deployer.address,
      deployer.address,
      deployer.address,
      deployer.address,
      cfg.pool,
    );
    await strategy.waitForDeployment();

    // Transfer USDC from whale to deployer
    await usdc.connect(whale).transfer(deployer.address, DEPOSIT_AMOUNT);
  }

  async function stopImpersonatingWhale() {
    await hre.network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [cfg.whale],
    });
  }

  beforeEach(async function () {
    await setupFork();
  });

  afterEach(async function () {
    await stopImpersonatingWhale();
  });

  it("should deploy strategy with real Aave V3 pool address", async function () {
    expect(await strategy.aavePool()).to.equal(cfg.pool);
    expect(await strategy.vault()).to.equal(deployer.address);

    const aToken = await strategy.aToken();
    expect(aToken).to.not.equal("0x0000000000000000000000000000000000000000");
    console.log(`  aToken: ${aToken}`);
  });

  it("should supply USDC to Aave and receive aTokens (deployFunds)", async function () {
    await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
    const balanceBefore = await usdc.balanceOf(deployer.address);

    await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

    const balanceAfter = await usdc.balanceOf(deployer.address);
    expect(balanceAfter).to.equal(balanceBefore - DEPOSIT_AMOUNT);
    expect(await strategy.totalDebt()).to.equal(DEPOSIT_AMOUNT);

    console.log(`  Supplied ${formatUnits(DEPOSIT_AMOUNT, 6)} USDC to Aave on ${cfg.name}`);
  });

  it("should report correct totalAssets via aToken balance", async function () {
    await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
    await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

    const totalAssets = await strategy.totalAssets();
    expect(totalAssets).to.be.gte(DEPOSIT_AMOUNT);

    console.log(`  totalAssets: ${formatUnits(totalAssets, 6)} USDC`);
  });

  it("should withdraw USDC from Aave (freeFunds)", async function () {
    await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
    await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

    const freeAmount = DEPOSIT_AMOUNT / 2n;
    await strategy.connect(deployer).freeFunds(freeAmount);

    const balance = await usdc.balanceOf(deployer.address);
    expect(balance).to.be.gte(freeAmount);
    expect(await strategy.totalDebt()).to.equal(DEPOSIT_AMOUNT - freeAmount);

    console.log(`  Withdrew ${formatUnits(freeAmount, 6)} USDC from Aave`);
  });

  it("should complete full lifecycle: deployFunds -> harvestAndReport -> freeFunds", async function () {
    await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
    await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

    const reported = await strategy.connect(deployer).harvestAndReport.staticCall();
    await strategy.connect(deployer).harvestAndReport();
    expect(reported).to.be.gte(DEPOSIT_AMOUNT);

    const totalDebt = await strategy.totalDebt();
    await strategy.connect(deployer).freeFunds(totalDebt);

    expect(await strategy.totalDebt()).to.equal(0n);

    const finalBalance = await usdc.balanceOf(deployer.address);
    expect(finalBalance).to.be.gte(DEPOSIT_AMOUNT);

    console.log(`  Lifecycle complete: reported ${formatUnits(reported, 6)} USDC`);
  });

  it("should emergencyWithdrawAll withdraw everything to vault", async function () {
    await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
    await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

    const vaultBalanceBefore = await usdc.balanceOf(deployer.address);
    await strategy.connect(deployer).emergencyWithdrawAll();

    const vaultBalanceAfter = await usdc.balanceOf(deployer.address);
    expect(vaultBalanceAfter).to.be.gt(vaultBalanceBefore);

    const totalAssets = await strategy.totalAssets();
    expect(totalAssets).to.be.lt(1000n);

    console.log(`  Emergency withdrawn: ${formatUnits(vaultBalanceAfter - vaultBalanceBefore, 6)} USDC`);
  });

  it("should revert deployFunds when called by non-vault", async function () {
    const [, nonVault] = await hre.ethers.getSigners();
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [nonVault.address, "0x" + parseUnits("1", 18).toString(16)],
    });

    await usdc.connect(whale).transfer(nonVault.address, DEPOSIT_AMOUNT);
    await usdc.connect(nonVault).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);

    await expect(
      strategy.connect(nonVault).deployFunds(DEPOSIT_AMOUNT)
    ).to.be.reverted;
  });

  it("should revert freeFunds when amount exceeds totalDebt", async function () {
    await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
    await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

    await expect(
      strategy.connect(deployer).freeFunds(DEPOSIT_AMOUNT + 1n)
    ).to.be.reverted;
  });
});
