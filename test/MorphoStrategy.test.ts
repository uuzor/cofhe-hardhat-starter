import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { expect } from "chai";

describe("MorphoStrategy", function () {
  async function deployMorphoFixture() {
    const [deployer, vault, management, keeper, emergencyAdmin, user] =
      await hre.ethers.getSigners();

    // Deploy mock asset
    const MockERC20Factory = await hre.ethers.getContractFactory("MockERC20");
    const asset = await MockERC20Factory.deploy("Mock USDC", "USDC", 6);

    // Deploy mock Morpho vault (1% yield per report cycle)
    const MockMorphoFactory = await hre.ethers.getContractFactory("MockMorphoVault");
    const morphoVault = await MockMorphoFactory.deploy(
      await asset.getAddress(),
      "Morpho USDC",
      "mUSDC",
      100n // 1% per report
    );

    // Deploy MorphoStrategy
    const MorphoStrategyFactory = await hre.ethers.getContractFactory("MorphoStrategy");
    const strategy = await MorphoStrategyFactory.deploy(
      await asset.getAddress(),
      vault.address,
      management.address,
      keeper.address,
      emergencyAdmin.address,
      await morphoVault.getAddress()
    );

    // Mint tokens to user
    await asset.mint(user.address, 10_000_000n * 10n ** 6n);

    return {
      asset,
      morphoVault,
      strategy,
      deployer,
      vault,
      management,
      keeper,
      emergencyAdmin,
      user,
    };
  }

  describe("deployment", function () {
    it("should deploy with correct parameters", async function () {
      const { strategy, asset, vault, management, keeper, emergencyAdmin, morphoVault } =
        await loadFixture(deployMorphoFixture);

      expect(await strategy.asset()).to.equal(await asset.getAddress());
      expect(await strategy.vault()).to.equal(vault.address);
      expect(await strategy.management()).to.equal(management.address);
      expect(await strategy.keeper()).to.equal(keeper.address);
      expect(await strategy.emergencyAdmin()).to.equal(emergencyAdmin.address);
      expect(await strategy.morphoVault()).to.equal(await morphoVault.getAddress());
      expect(await strategy.isActive()).to.be.true;
    });

    it("should revert with zero morpho vault address", async function () {
      const { asset, vault, management, keeper, emergencyAdmin } =
        await loadFixture(deployMorphoFixture);

      const MorphoStrategyFactory = await hre.ethers.getContractFactory("MorphoStrategy");
      await expect(
        MorphoStrategyFactory.deploy(
          await asset.getAddress(),
          vault.address,
          management.address,
          keeper.address,
          emergencyAdmin.address,
          hre.ethers.ZeroAddress
        )
      ).to.be.revertedWith("MS: zero morpho vault");
    });
  });

  describe("deployFunds", function () {
    it("should deposit assets into Morpho vault", async function () {
      const { strategy, asset, vault, user } = await loadFixture(deployMorphoFixture);

      const DEPOSIT = 1000n * 10n ** 6n;
      await asset.mint(vault.address, DEPOSIT);

      // Vault approves and deploys
      await asset.connect(vault).approve(await strategy.getAddress(), DEPOSIT);
      await strategy.connect(vault).deployFunds(DEPOSIT);

      // Check Morpho vault balance
      const mv = await hre.ethers.getContractAt("MockMorphoVault", await strategy.morphoVault());
      const shares = await mv.balanceOf(await strategy.getAddress());
      expect(shares).to.equal(DEPOSIT); // 1:1 on first deposit
      expect(await strategy.totalDebt()).to.equal(DEPOSIT);
    });
  });

  describe("freeFunds", function () {
    it("should withdraw assets from Morpho vault back to vault", async function () {
      const { strategy, asset, vault, user } = await loadFixture(deployMorphoFixture);

      const DEPOSIT = 1000n * 10n ** 6n;
      await asset.mint(vault.address, DEPOSIT);
      await asset.connect(vault).approve(await strategy.getAddress(), DEPOSIT);
      await strategy.connect(vault).deployFunds(DEPOSIT);

      // Free funds
      await strategy.connect(vault).freeFunds(DEPOSIT);

      // Vault should have received the assets back
      expect(await asset.balanceOf(vault.address)).to.equal(DEPOSIT);
      expect(await strategy.totalDebt()).to.equal(0n);
    });

    it("should revert if amount exceeds debt", async function () {
      const { strategy, vault } = await loadFixture(deployMorphoFixture);

      await expect(
        strategy.connect(vault).freeFunds(1000n)
      ).to.be.revertedWith("BS: amount exceeds debt");
    });
  });

  describe("harvestAndReport", function () {
    it("should report assets including yield", async function () {
      const { strategy, asset, morphoVault, vault, keeper } = await loadFixture(deployMorphoFixture);

      const DEPOSIT = 1000n * 10n ** 6n;
      await asset.mint(vault.address, DEPOSIT);
      await asset.connect(vault).approve(await strategy.getAddress(), DEPOSIT);
      await strategy.connect(vault).deployFunds(DEPOSIT);

      // Simulate yield by minting extra tokens to morpho vault
      await asset.mint(await morphoVault.getAddress(), 100n * 10n ** 6n);

      // Report yield (increments report count)
      await morphoVault.reportYield();

      const reported = await strategy.connect(keeper).harvestAndReport.staticCall();
      expect(reported).to.be.gt(DEPOSIT); // Should include yield
    });
  });

  describe("totalAssets", function () {
    it("should return Morpho vault position value", async function () {
      const { strategy, asset, vault } = await loadFixture(deployMorphoFixture);

      const DEPOSIT = 1000n * 10n ** 6n;
      await asset.mint(vault.address, DEPOSIT);
      await asset.connect(vault).approve(await strategy.getAddress(), DEPOSIT);
      await strategy.connect(vault).deployFunds(DEPOSIT);

      const totalAssets = await strategy.totalAssets();
      expect(totalAssets).to.equal(DEPOSIT); // 1:1 initially
    });
  });

  describe("emergencyWithdrawAll", function () {
    it("should withdraw all assets to vault", async function () {
      const { strategy, asset, vault, emergencyAdmin } = await loadFixture(deployMorphoFixture);

      const DEPOSIT = 1000n * 10n ** 6n;
      await asset.mint(vault.address, DEPOSIT);
      await asset.connect(vault).approve(await strategy.getAddress(), DEPOSIT);
      await strategy.connect(vault).deployFunds(DEPOSIT);

      // Emergency withdraw
      await strategy.connect(emergencyAdmin).emergencyWithdrawAll();

      // Vault should have all assets
      expect(await asset.balanceOf(vault.address)).to.equal(DEPOSIT);
    });

    it("should revert if not emergency admin", async function () {
      const { strategy, user } = await loadFixture(deployMorphoFixture);

      await expect(
        strategy.connect(user).emergencyWithdrawAll()
      ).to.be.revertedWith("BS: not emergency admin");
    });
  });

  describe("pause/unpause", function () {
    it("should pause and prevent deposits", async function () {
      const { strategy, asset, vault, emergencyAdmin } = await loadFixture(deployMorphoFixture);

      await asset.mint(vault.address, 1000n);
      await asset.connect(vault).approve(await strategy.getAddress(), 1000n);

      await strategy.connect(emergencyAdmin).pause();
      expect(await strategy.paused()).to.be.true;

      // Now deployFunds should revert because strategy is paused
      await expect(
        strategy.connect(vault).deployFunds(1000n)
      ).to.be.revertedWith("BS: paused");
    });

    it("should unpause and allow deposits again", async function () {
      const { strategy, emergencyAdmin } = await loadFixture(deployMorphoFixture);

      await strategy.connect(emergencyAdmin).pause();
      await strategy.connect(emergencyAdmin).unpause();
      expect(await strategy.paused()).to.be.false;
    });
  });
});
