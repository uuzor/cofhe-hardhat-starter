import hre from "hardhat";
import { expect } from "chai";
import { parseUnits, formatUnits } from "ethers";

// Skip fork tests if not running in fork mode
const FORK_ENABLED = process.env.FORK_NETWORK === "eth-mainnet";
const describeFork = FORK_ENABLED ? describe : describe.skip;

// Ethereum mainnet addresses
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0x55FE002aefF02F77364de339a1292923A15844B8";

const DEPOSIT_AMOUNT = 1_000_000n * 10n ** 6n; // 1M USDC

describeFork("AaveV3YDSStrategy — Ethereum Mainnet Fork", function () {
  // Increase timeout for fork tests (loading mainnet state is slow)
  this.timeout(120000);

  let deployer: any;
  let whale: any;
  let strategy: any;
  let usdc: any;

  async function setupFork() {
    [deployer] = await hre.ethers.getSigners();

    // Impersonate whale
    whale = await hre.ethers.getImpersonatedSigner(USDC_WHALE);

    // Give whale ETH for gas
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [USDC_WHALE, "0x" + parseUnits("100", 18).toString(16)],
    });

    // Get USDC contract (use IERC20 interface)
    usdc = await hre.ethers.getContractAt(
      "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
      USDC
    );

    // Deploy strategy
    const StrategyFactory = await hre.ethers.getContractFactory("AaveV3YDSStrategy");
    strategy = await StrategyFactory.connect(deployer).deploy(
      USDC,
      deployer.address, // vault = deployer
      deployer.address, // management
      deployer.address, // keeper
      deployer.address, // emergencyAdmin
      AAVE_V3_POOL
    );
    await strategy.waitForDeployment();

    // Transfer USDC from whale to deployer (the "vault")
    await usdc.connect(whale).transfer(deployer.address, DEPOSIT_AMOUNT);
  }

  describe("Ethereum Mainnet Fork", function () {
    beforeEach(async function () {
      await setupFork();
    });

    it("should deploy strategy with real Aave V3 pool address", async function () {
      expect(await strategy.aavePool()).to.equal(AAVE_V3_POOL);
      expect(await strategy.vault()).to.equal(deployer.address);
      expect(await strategy.keeper()).to.equal(deployer.address);

      // aToken address should be non-zero (aUSDC)
      const aToken = await strategy.aToken();
      expect(aToken).to.not.equal("0x0000000000000000000000000000000000000000");
      console.log(`  aToken (aUSDC): ${aToken}`);
    });

    it("should supply USDC to Aave and receive aTokens (deployFunds)", async function () {
      // Deployer approves strategy
      await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);

      const balanceBefore = await usdc.balanceOf(deployer.address);

      // Deploy funds
      await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

      const balanceAfter = await usdc.balanceOf(deployer.address);
      expect(balanceAfter).to.equal(balanceBefore - DEPOSIT_AMOUNT);
      expect(await strategy.totalDebt()).to.equal(DEPOSIT_AMOUNT);

      console.log(`  Supplied ${formatUnits(DEPOSIT_AMOUNT, 6)} USDC to Aave`);
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

      const debtAfterDeploy = await strategy.totalDebt();
      expect(debtAfterDeploy).to.equal(DEPOSIT_AMOUNT);

      // Use staticCall to get the return value, then actually call it to persist state
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

    it("should show profit after time advancement (yield accrual)", async function () {
      await usdc.connect(deployer).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);
      await strategy.connect(deployer).deployFunds(DEPOSIT_AMOUNT);

      const initialReport = await strategy.connect(deployer).harvestAndReport.staticCall();
      await strategy.connect(deployer).harvestAndReport();

      // Advance time by 30 days
      await hre.network.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
      await hre.network.provider.send("evm_mine", []);

      const afterReport = await strategy.connect(deployer).harvestAndReport.staticCall();
      expect(afterReport).to.be.gt(initialReport);

      const profit = afterReport - initialReport;
      console.log(`  Interest accrued over 30 days: ${formatUnits(profit, 6)} USDC`);
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

      await usdc.connect(whale).transfer(nonVault.address, DEPOSIT_AMOUNT);
      await usdc.connect(nonVault).approve(await strategy.getAddress(), DEPOSIT_AMOUNT);

      await expect(
        strategy.connect(nonVault).deployFunds(DEPOSIT_AMOUNT)
      ).to.be.reverted;
    });

    it("should revert freeFunds when amount exceeds totalDebt", async function () {
      const smallAmount = 100_000n * 10n ** 6n;
      await usdc.connect(deployer).approve(await strategy.getAddress(), smallAmount);
      await strategy.connect(deployer).deployFunds(smallAmount);

      await expect(
        strategy.connect(deployer).freeFunds(smallAmount + 1n)
      ).to.be.reverted;
    });
  });
});
