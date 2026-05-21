import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

const TASK_COFHE_MOCKS_DEPLOY = "task:cofhe-mocks:deploy";

describe("PrivateComposableVault", function () {
  async function deployVaultFixture() {
    await hre.run(TASK_COFHE_MOCKS_DEPLOY);

    const [owner, keeper, emergencyAdmin, user, recipient] =
      await hre.ethers.getSigners();

    // Deploy mock ERC20 asset (6 decimals like USDC)
    const MockERC20Factory = await hre.ethers.getContractFactory("MockERC20");
    const asset = await MockERC20Factory.deploy("Mock USDC", "USDC", 6);

    // Mint tokens to user and owner
    const ONE_MILLION = 1_000_000n * 10n ** 6n;
    await asset.mint(user.address, ONE_MILLION);
    await asset.mint(owner.address, ONE_MILLION);

    // Deploy FixedAllocationMechanism with 1 recipient
    const FAMFactory = await hre.ethers.getContractFactory("FixedAllocationMechanism");
    const mechanism = await FAMFactory.deploy(
      owner.address,
      [recipient.address],
      [10000n]
    );

    // Encrypt creator fee (200 bps = 2%)
    const client = await hre.cofhe.createClientWithBatteries(owner);
    const encFee = await client.encryptInputs([Encryptable.uint16(200n)]).execute();

    // Deploy PrivateComposableVault
    const VaultFactory = await hre.ethers.getContractFactory("PrivateComposableVault");
    const vault = await VaultFactory.connect(owner).deploy(
      await asset.getAddress(),
      "Private USDC Vault",
      "pvUSDC",
      owner.address,
      keeper.address,
      emergencyAdmin.address,
      recipient.address, // donationAddress
      encFee[0]
    );

    // Deploy EncryptedStrategyRegistry
    const RegistryFactory = await hre.ethers.getContractFactory("EncryptedStrategyRegistry");
    const registry = await RegistryFactory.connect(owner).deploy(
      await vault.getAddress(),
      owner.address,
      10,
      owner.address // factory = owner for testing
    );

    // Deploy YieldRouter
    const YieldRouterFactory = await hre.ethers.getContractFactory("YieldRouter");
    const yieldRouter = await YieldRouterFactory.deploy(
      await vault.getAddress(),
      await mechanism.getAddress()
    );

    // Initialize vault
    await vault.connect(owner).initialize(
      await registry.getAddress(),
      await yieldRouter.getAddress(),
      owner.address // rebalancer = owner for testing
    );

    // Deploy MockStrategy
    const MockStrategyFactory = await hre.ethers.getContractFactory("MockStrategy");
    const strategy = await MockStrategyFactory.deploy(
      await asset.getAddress(),
      await vault.getAddress()
    );

    const DEPOSIT_AMOUNT = 1000n * 10n ** 6n; // 1000 USDC

    return {
      vault,
      registry,
      yieldRouter,
      mechanism,
      strategy,
      asset,
      owner,
      keeper,
      emergencyAdmin,
      user,
      recipient,
      client,
      DEPOSIT_AMOUNT,
    };
  }

  describe("deposit", function () {
    it("should mint shares equal to assets on first deposit and update totalPrincipal", async function () {
      const { vault, asset, user, DEPOSIT_AMOUNT } = await loadFixture(deployVaultFixture);

      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      const shares = await vault.balanceOf(user.address);
      expect(shares).to.equal(DEPOSIT_AMOUNT);
      expect(await vault.totalPrincipal()).to.equal(DEPOSIT_AMOUNT);
    });

    it("should revert deposit when deposits are paused", async function () {
      const { vault, asset, user, owner, DEPOSIT_AMOUNT } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).pauseDeposits();
      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);

      await expect(
        vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address)
      ).to.be.revertedWith("PCV: deposits paused");
    });

    it("should allow deposit after unpausing", async function () {
      const { vault, asset, user, owner, DEPOSIT_AMOUNT } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).pauseDeposits();
      await vault.connect(owner).unpauseDeposits();

      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      expect(await vault.balanceOf(user.address)).to.equal(DEPOSIT_AMOUNT);
    });
  });

  describe("withdraw", function () {
    it("should burn shares and reduce totalPrincipal on withdraw", async function () {
      const { vault, asset, user, DEPOSIT_AMOUNT } = await loadFixture(deployVaultFixture);

      // First deposit
      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT / 2n;
      await vault.connect(user).withdraw(WITHDRAW_AMOUNT, user.address, user.address);

      const shares = await vault.balanceOf(user.address);
      expect(shares).to.equal(DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);
      expect(await vault.totalPrincipal()).to.equal(DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);
    });

    it("should revert withdraw when withdrawals are paused", async function () {
      const { vault, asset, user, owner, DEPOSIT_AMOUNT } = await loadFixture(deployVaultFixture);

      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      await vault.connect(owner).pauseWithdrawals();

      await expect(
        vault.connect(user).withdraw(DEPOSIT_AMOUNT / 2n, user.address, user.address)
      ).to.be.revertedWith("PCV: withdrawals paused");
    });
  });

  describe("totalAssets", function () {
    it("should return vault cash when no strategies deployed", async function () {
      const { vault, asset, user, DEPOSIT_AMOUNT } = await loadFixture(deployVaultFixture);

      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      const totalAssets = await vault.totalAssets();
      expect(totalAssets).to.equal(DEPOSIT_AMOUNT);
    });

    it("should include strategy assets in totalAssets", async function () {
      const { vault, registry, strategy, asset, user, owner, keeper, DEPOSIT_AMOUNT } =
        await loadFixture(deployVaultFixture);

      // Add strategy to registry and vault
      const client = await hre.cofhe.createClientWithBatteries(owner);
      const encWeight = await client.encryptInputs([Encryptable.uint16(10000n)]).execute();
      await registry.connect(owner).addStrategy(await strategy.getAddress(), encWeight[0]);
      await vault.connect(owner).addStrategy(await strategy.getAddress());

      // Deposit
      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      // Deploy half to strategy
      const deployAmount = DEPOSIT_AMOUNT / 2n;
      await asset.connect(owner).approve(await strategy.getAddress(), deployAmount); // not needed since vault does it
      await vault.connect(keeper).deployToStrategy(await strategy.getAddress(), deployAmount);

      // Strategy reports more assets (simulated profit)
      await strategy.setMockTotalAssets(deployAmount + 100n * 10n ** 6n);

      const totalAssets = await vault.totalAssets();
      // Should be: vault cash + strategy assets = deployAmount + (deployAmount + profit)
      const expectedVaultCash = DEPOSIT_AMOUNT - deployAmount;
      const expectedStrategyAssets = deployAmount + 100n * 10n ** 6n;
      expect(totalAssets).to.equal(expectedVaultCash + expectedStrategyAssets);
    });
  });

  describe("pricePerShare", function () {
    it("should return 1e18 when no deposits", async function () {
      const { vault } = await loadFixture(deployVaultFixture);
      expect(await vault.pricePerShare()).to.equal(10n ** 18n);
    });

    it("should return 1e18 after initial deposit (1:1 ratio)", async function () {
      const { vault, asset, user, DEPOSIT_AMOUNT } = await loadFixture(deployVaultFixture);

      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      expect(await vault.pricePerShare()).to.equal(10n ** 18n);
    });
  });

  describe("deposit pause", function () {
    it("pauseDeposits and unpauseDeposits toggle correctly", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      expect(await vault.depositsPaused()).to.be.false;

      await vault.connect(owner).pauseDeposits();
      expect(await vault.depositsPaused()).to.be.true;

      await vault.connect(owner).unpauseDeposits();
      expect(await vault.depositsPaused()).to.be.false;
    });

    it("emergencyAdmin can also pause deposits", async function () {
      const { vault, emergencyAdmin } = await loadFixture(deployVaultFixture);

      await vault.connect(emergencyAdmin).pauseDeposits();
      expect(await vault.depositsPaused()).to.be.true;
    });
  });

  describe("report", function () {
    it("should mint donation shares to yieldRouter on profit", async function () {
      const { vault, registry, strategy, yieldRouter, asset, user, owner, keeper, DEPOSIT_AMOUNT } =
        await loadFixture(deployVaultFixture);

      // Setup: add strategy to registry and vault
      const client = await hre.cofhe.createClientWithBatteries(owner);
      const encWeight = await client.encryptInputs([Encryptable.uint16(10000n)]).execute();
      await registry.connect(owner).addStrategy(await strategy.getAddress(), encWeight[0]);
      await vault.connect(owner).addStrategy(await strategy.getAddress());

      // Deposit
      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      // Deploy to strategy
      await vault.connect(keeper).deployToStrategy(await strategy.getAddress(), DEPOSIT_AMOUNT);

      // Simulate profit: strategy now has more assets
      const PROFIT = 100n * 10n ** 6n;
      await strategy.setMockTotalAssets(DEPOSIT_AMOUNT + PROFIT);

      const yieldRouterSharesBefore = await vault.balanceOf(await yieldRouter.getAddress());
      expect(yieldRouterSharesBefore).to.equal(0n);

      // Report profit
      await vault.connect(keeper).report(await strategy.getAddress());

      const yieldRouterSharesAfter = await vault.balanceOf(await yieldRouter.getAddress());
      // Donation shares should have been minted to yieldRouter
      expect(yieldRouterSharesAfter).to.be.gt(0n);
    });

    it("should burn donation shares on small loss", async function () {
      const { vault, registry, strategy, yieldRouter, asset, user, owner, keeper, DEPOSIT_AMOUNT } =
        await loadFixture(deployVaultFixture);

      const client = await hre.cofhe.createClientWithBatteries(owner);
      const encWeight = await client.encryptInputs([Encryptable.uint16(10000n)]).execute();
      await registry.connect(owner).addStrategy(await strategy.getAddress(), encWeight[0]);
      await vault.connect(owner).addStrategy(await strategy.getAddress());

      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);
      await vault.connect(keeper).deployToStrategy(await strategy.getAddress(), DEPOSIT_AMOUNT);

      // First generate profit to have donation shares
      const PROFIT = 100n * 10n ** 6n;
      await strategy.setMockTotalAssets(DEPOSIT_AMOUNT + PROFIT);
      await vault.connect(keeper).report(await strategy.getAddress());

      const donationSharesBefore = await vault.balanceOf(await yieldRouter.getAddress());
      expect(donationSharesBefore).to.be.gt(0n);

      // Now simulate a small loss (less than donation buffer)
      const LOSS = 10n * 10n ** 6n;
      await strategy.setMockTotalAssets(DEPOSIT_AMOUNT + PROFIT - LOSS);
      await vault.connect(keeper).report(await strategy.getAddress());

      const donationSharesAfter = await vault.balanceOf(await yieldRouter.getAddress());
      // Donation shares should have decreased to cover the loss
      expect(donationSharesAfter).to.be.lt(donationSharesBefore);
    });

    it("should burn all donation shares on large loss", async function () {
      const { vault, registry, strategy, yieldRouter, asset, user, owner, keeper, DEPOSIT_AMOUNT } =
        await loadFixture(deployVaultFixture);

      const client = await hre.cofhe.createClientWithBatteries(owner);
      const encWeight = await client.encryptInputs([Encryptable.uint16(10000n)]).execute();
      await registry.connect(owner).addStrategy(await strategy.getAddress(), encWeight[0]);
      await vault.connect(owner).addStrategy(await strategy.getAddress());

      await asset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);
      await vault.connect(keeper).deployToStrategy(await strategy.getAddress(), DEPOSIT_AMOUNT);

      // Generate some profit first
      const PROFIT = 50n * 10n ** 6n;
      await strategy.setMockTotalAssets(DEPOSIT_AMOUNT + PROFIT);
      await vault.connect(keeper).report(await strategy.getAddress());

      const donationSharesBefore = await vault.balanceOf(await yieldRouter.getAddress());
      expect(donationSharesBefore).to.be.gt(0n);

      // Now simulate a LARGE loss (much more than donation buffer)
      const LARGE_LOSS = 500n * 10n ** 6n;
      const currentDebt = DEPOSIT_AMOUNT + PROFIT;
      const newAssets = currentDebt > LARGE_LOSS ? currentDebt - LARGE_LOSS : 0n;
      await strategy.setMockTotalAssets(newAssets);
      await vault.connect(keeper).report(await strategy.getAddress());

      const donationSharesAfter = await vault.balanceOf(await yieldRouter.getAddress());
      // All donation shares should be burned
      expect(donationSharesAfter).to.equal(0n);
    });
  });

  describe("initialize", function () {
    it("should revert if initialize is called again", async function () {
      const { vault, registry, yieldRouter, owner } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(owner).initialize(
          await registry.getAddress(),
          await yieldRouter.getAddress(),
          owner.address
        )
      ).to.be.revertedWith("PCV: already initialized");
    });
  });

  describe("strategy management", function () {
    it("should revert addStrategy if not in registry", async function () {
      const { vault, strategy, owner } = await loadFixture(deployVaultFixture);

      // Strategy not registered in registry
      await expect(
        vault.connect(owner).addStrategy(await strategy.getAddress())
      ).to.be.revertedWith("PCV: not in registry");
    });

    it("should revert non-owner addStrategy", async function () {
      const { vault, strategy, user } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(user).addStrategy(await strategy.getAddress())
      ).to.be.revertedWith("PCV: not owner");
    });
  });

  describe("removeStrategy", function () {
    async function deploySetupWithStrategy() {
      const base = await deployVaultFixture();
      const { vault, registry, strategy, asset, owner, keeper, client } = base;

      // Add strategy to registry and vault
      const encWeight = await client.encryptInputs([Encryptable.uint16(10000n)]).execute();
      await registry.connect(owner).addStrategy(await strategy.getAddress(), encWeight[0]);
      await vault.connect(owner).addStrategy(await strategy.getAddress());

      // Deposit and deploy to strategy
      await asset.connect(owner).approve(await vault.getAddress(), base.DEPOSIT_AMOUNT);
      await vault.connect(owner).deposit(base.DEPOSIT_AMOUNT, owner.address);
      await vault.connect(keeper).deployToStrategy(await strategy.getAddress(), base.DEPOSIT_AMOUNT);

      return { ...base, vault, registry, strategy, asset, owner, keeper, client };
    }

    it("should remove strategy after withdrawing all funds", async function () {
      const { vault, registry, strategy, owner } = await loadFixture(deploySetupWithStrategy);

      // Report (to sync debt with actual assets)
      await vault.connect(owner).report(await strategy.getAddress());

      // Withdraw all funds
      await vault.connect(owner).withdrawAllFromStrategy(await strategy.getAddress());

      // Verify debt is zero
      expect(await vault.strategyDebt(await strategy.getAddress())).to.equal(0n);

      // Remove strategy
      await vault.connect(owner).removeStrategy(await strategy.getAddress());

      // Verify removed from vault
      expect(await vault.isStrategy(await strategy.getAddress())).to.be.false;
      expect(await vault.strategyCount()).to.equal(0n);

      // Verify removed from registry
      expect(await registry.isStrategyRegistered(await strategy.getAddress())).to.be.false;
    });

    it("should revert removeStrategy if strategy has debt", async function () {
      const { vault, strategy, owner } = await loadFixture(deploySetupWithStrategy);

      // Don't withdraw — strategy still has debt
      await expect(
        vault.connect(owner).removeStrategy(await strategy.getAddress())
      ).to.be.revertedWith("PCV: strategy has debt");
    });

    it("should revert removeStrategy if strategy still has assets", async function () {
      const { vault, registry, strategy, asset, owner, keeper, client } =
        await loadFixture(deploySetupWithStrategy);

      // Withdraw from strategy (returns funds to vault)
      await vault.connect(keeper).withdrawFromStrategy(await strategy.getAddress(), await vault.strategyDebt(await strategy.getAddress()));

      // Strategy should have 0 assets (MockStrategy returns mockTotalAssets)
      // Set mock total assets to 0
      await strategy.setMockTotalAssets(0n);

      // Report to sync
      await vault.connect(keeper).report(await strategy.getAddress());

      // Now debt should be 0 and assets should be 0
      const debt = await vault.strategyDebt(await strategy.getAddress());
      expect(debt).to.equal(0n);

      // Should succeed
      await vault.connect(owner).removeStrategy(await strategy.getAddress());
      expect(await vault.isStrategy(await strategy.getAddress())).to.be.false;
    });

    it("should revert removeStrategy if not a strategy", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(owner).removeStrategy(vault.getAddress())
      ).to.be.revertedWith("PCV: not a strategy");
    });

    it("should revert removeStrategy if not owner", async function () {
      const { vault, strategy, user } = await loadFixture(deploySetupWithStrategy);

      await expect(
        vault.connect(user).removeStrategy(await strategy.getAddress())
      ).to.be.revertedWith("PCV: not owner");
    });

    it("swap-and-pop: remove middle strategy, last moves to middle position", async function () {
      const { vault, registry, asset, owner, keeper, client } =
        await loadFixture(deployVaultFixture);

      // Deploy 3 strategies
      const MockStrategyFactory = await hre.ethers.getContractFactory("MockStrategy");
      const s1 = await MockStrategyFactory.deploy(await asset.getAddress(), await vault.getAddress());
      const s2 = await MockStrategyFactory.deploy(await asset.getAddress(), await vault.getAddress());
      const s3 = await MockStrategyFactory.deploy(await asset.getAddress(), await vault.getAddress());

      const encWeight = await client.encryptInputs([Encryptable.uint16(3333n)]).execute();
      const encWeight2 = await client.encryptInputs([Encryptable.uint16(3333n)]).execute();
      const encWeight3 = await client.encryptInputs([Encryptable.uint16(3334n)]).execute();

      await registry.connect(owner).addStrategy(await s1.getAddress(), encWeight[0]);
      await registry.connect(owner).addStrategy(await s2.getAddress(), encWeight2[0]);
      await registry.connect(owner).addStrategy(await s3.getAddress(), encWeight3[0]);

      await vault.connect(owner).addStrategy(await s1.getAddress());
      await vault.connect(owner).addStrategy(await s2.getAddress());
      await vault.connect(owner).addStrategy(await s3.getAddress());

      // Verify 3 strategies
      const strategiesBefore = await vault.getStrategies();
      expect(strategiesBefore.length).to.equal(3);
      expect(strategiesBefore[1]).to.equal(await s2.getAddress()); // s2 is in middle

      // Remove s2 (middle) — s3 should move to position 1
      await vault.connect(owner).removeStrategy(await s2.getAddress());

      const strategiesAfter = await vault.getStrategies();
      expect(strategiesAfter.length).to.equal(2);
      // After swap-and-pop: s3 moves to s2's position
      expect(strategiesAfter[1]).to.equal(await s3.getAddress());
    });

    it("isStrategy returns true for active strategies", async function () {
      const { vault, strategy, owner } = await loadFixture(deploySetupWithStrategy);

      expect(await vault.isStrategy(await strategy.getAddress())).to.be.true;
    });

    it("getStrategies returns all active strategies", async function () {
      const { vault, strategy, owner } = await loadFixture(deploySetupWithStrategy);

      const strategies = await vault.getStrategies();
      expect(strategies.length).to.equal(1);
      expect(strategies[0]).to.equal(await strategy.getAddress());
    });
  });
});
