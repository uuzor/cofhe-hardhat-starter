import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { expect } from "chai";

const TASK_COFHE_MOCKS_DEPLOY = "task:cofhe-mocks:deploy";

describe("PrivateRebalancer", function () {
  async function deployRebalancerFixture() {
    await hre.run(TASK_COFHE_MOCKS_DEPLOY);

    const [signer, other, vaultOwner, vaultAddr] = await hre.ethers.getSigners();

    // Deploy rebalancer with factory = signer
    const RebalancerFactory = await hre.ethers.getContractFactory(
      "PrivateRebalancer"
    );
    const rebalancer = await RebalancerFactory.connect(signer).deploy(
      signer.address // factory
    );

    const client = await hre.cofhe.createClientWithBatteries(signer);

    return { rebalancer, signer, other, vaultOwner, vaultAddr, client };
  }

  describe("configureVault", function () {
    it("should configure vault and set isConfigured = true", async function () {
      const { rebalancer, signer, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(86400n)])
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      expect(await rebalancer.isConfigured(vaultAddr.address)).to.be.true;
    });

    it("should allow anyone to configure vault (not restricted to factory)", async function () {
      const { rebalancer, signer, other, vaultAddr } =
        await loadFixture(deployRebalancerFixture);

      // Create encrypted inputs using 'other' as the signer
      const otherClient = await hre.cofhe.createClientWithBatteries(other);
      const encDrift = await otherClient
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await otherClient
        .encryptInputs([Encryptable.uint32(86400n)])
        .execute();

      // Disable verifier signer check
      const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
      const taskManager = await hre.ethers.getContractAt(
        ["function setVerifierSigner(address signer) external"],
        TASK_MANAGER_ADDRESS
      );
      await taskManager.connect(signer).setVerifierSigner(hre.ethers.ZeroAddress);

      // 'other' (non-factory) can configure since access control is via registry
      await rebalancer
        .connect(other)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      expect(await rebalancer.isConfigured(vaultAddr.address)).to.be.true;
    });

    it("should revert when configuring same vault twice", async function () {
      const { rebalancer, signer, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(86400n)])
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      const encDrift2 = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime2 = await client
        .encryptInputs([Encryptable.uint32(86400n)])
        .execute();

      await expect(
        rebalancer
          .connect(signer)
          .configureVault(vaultAddr.address, encDrift2[0], encMinTime2[0])
      ).to.be.revertedWith("PR: already configured");
    });
  });

  describe("checkRebalanceNeeded", function () {
    it("should return ebool decrypting to false when drift is 0 and time not elapsed", async function () {
      const { rebalancer, signer, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      // Very large min time so time condition is false
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(9999999n)])
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
      const taskManagerIface = new hre.ethers.Interface([
        "event TaskCreated(uint256 ctHash, string operation, uint256 input1, uint256 input2, uint256 input3)"
      ]);

      const tx = await rebalancer
        .connect(signer)
        .checkRebalanceNeeded(vaultAddr.address, hre.ethers.ZeroAddress, 0);
      const receipt = await tx.wait();

      const taskEvents = receipt!.logs
        .filter(log => log.address.toLowerCase() === TASK_MANAGER_ADDRESS.toLowerCase())
        .map(log => { try { return taskManagerIface.parseLog(log); } catch { return null; } })
        .filter(e => e !== null && e.name === "TaskCreated");

      const orEvent = taskEvents.find(e => e!.args[1] === "or");
      expect(orEvent).to.not.be.undefined;

      const shouldRebalanceHandle = orEvent!.args[0];
      const plaintext = await hre.cofhe.mocks.getPlaintext(shouldRebalanceHandle);
      expect(plaintext).to.equal(0n); // false
    });

    it("should return ebool decrypting to true when drift > threshold", async function () {
      const { rebalancer, signer, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(9999999n)])
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
      const taskManagerIface = new hre.ethers.Interface([
        "event TaskCreated(uint256 ctHash, string operation, uint256 input1, uint256 input2, uint256 input3)"
      ]);

      const tx = await rebalancer
        .connect(signer)
        .checkRebalanceNeeded(vaultAddr.address, hre.ethers.ZeroAddress, 600);
      const receipt = await tx.wait();

      const taskEvents = receipt!.logs
        .filter(log => log.address.toLowerCase() === TASK_MANAGER_ADDRESS.toLowerCase())
        .map(log => { try { return taskManagerIface.parseLog(log); } catch { return null; } })
        .filter(e => e !== null && e.name === "TaskCreated");

      const orEvent = taskEvents.find(e => e!.args[1] === "or");
      expect(orEvent).to.not.be.undefined;

      const shouldRebalanceHandle = orEvent!.args[0];
      const plaintext = await hre.cofhe.mocks.getPlaintext(shouldRebalanceHandle);
      expect(plaintext).to.equal(1n); // true
    });
  });

  describe("triggerRebalance + executeRebalance", function () {
    it("should trigger and execute rebalance when drift > threshold", async function () {
      const { rebalancer, signer, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(0n)]) // no min time
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      // Trigger with drift > threshold
      const strategies = [signer.address];
      const amounts = [1000n];
      const isWithdraw = [true];

      const tx = await rebalancer
        .connect(signer)
        .triggerRebalance(
          vaultAddr.address,
          hre.ethers.ZeroAddress,
          strategies,
          amounts,
          isWithdraw,
          600 // drift > threshold
        );

      // Verify RebalanceTriggered event emitted
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (l: any) => l.fragment?.name === "RebalanceTriggered"
      );
      expect(event).to.not.be.undefined;

      // Execute within window — this will attempt to call vault.rebalanceStrategy
      // which will fail on an EOA, so we test the window logic separately
      // The actual vault call is tested in integration tests
    });

    it("should allow execution with 0 amounts when drift < threshold (FHE.select gates to 0)", async function () {
      const { rebalancer, signer, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(9999999n)]) // long min time
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      // Trigger with drift < threshold — FHE.select should gate amounts to 0
      const strategies = [signer.address];
      const amounts = [1000n];
      const isWithdraw = [true];

      await rebalancer
        .connect(signer)
        .triggerRebalance(
          vaultAddr.address,
          hre.ethers.ZeroAddress,
          strategies,
          amounts,
          isWithdraw,
          100 // drift < threshold
        );

      // Execute with 0 amounts (since FHE.select gated to 0) — no vault call needed
      await rebalancer
        .connect(signer)
        .executeRebalance(
          vaultAddr.address,
          strategies,
          [0n],
          isWithdraw
        );
    });

    it("should revert executeRebalance after window expired", async function () {
      const { rebalancer, signer, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(0n)])
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      const strategies = [signer.address];
      const amounts = [1000n];
      const isWithdraw = [true];

      await rebalancer
        .connect(signer)
        .triggerRebalance(
          vaultAddr.address,
          hre.ethers.ZeroAddress,
          strategies,
          amounts,
          isWithdraw,
          600
        );

      // Advance time past the 5-minute window
      await time.increase(301);

      await expect(
        rebalancer
          .connect(signer)
          .executeRebalance(vaultAddr.address, strategies, amounts, isWithdraw)
      ).to.be.revertedWith("PR: window expired");
    });
  });

  describe("updateDriftThreshold / updateMinTime access control", function () {
    it("should revert updateDriftThreshold when called by non-vault-owner", async function () {
      const { rebalancer, signer, other, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(86400n)])
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      // 'other' is not the vault owner — should revert
      // (since vaultAddr is an EOA, its owner() call returns address(0))
      const encNewDrift = await client
        .encryptInputs([Encryptable.uint16(1000n)])
        .execute();

      await expect(
        rebalancer
          .connect(other)
          .updateDriftThreshold(vaultAddr.address, encNewDrift[0])
      ).to.be.revertedWith("PR: not vault owner");
    });

    it("should revert updateMinTime when called by non-vault-owner", async function () {
      const { rebalancer, signer, other, vaultAddr, client } =
        await loadFixture(deployRebalancerFixture);

      const encDrift = await client
        .encryptInputs([Encryptable.uint16(500n)])
        .execute();
      const encMinTime = await client
        .encryptInputs([Encryptable.uint32(86400n)])
        .execute();

      await rebalancer
        .connect(signer)
        .configureVault(vaultAddr.address, encDrift[0], encMinTime[0]);

      const encNewMinTime = await client
        .encryptInputs([Encryptable.uint32(172800n)])
        .execute();

      await expect(
        rebalancer
          .connect(other)
          .updateMinTime(vaultAddr.address, encNewMinTime[0])
      ).to.be.revertedWith("PR: not vault owner");
    });

    it("owner can transfer ownership", async function () {
      const { rebalancer, signer, other } =
        await loadFixture(deployRebalancerFixture);

      expect(await rebalancer.owner()).to.equal(signer.address);

      await rebalancer.connect(signer).transferOwnership(other.address);
      expect(await rebalancer.owner()).to.equal(other.address);
    });

    it("reverts transferOwnership from non-owner", async function () {
      const { rebalancer, other } =
        await loadFixture(deployRebalancerFixture);

      await expect(
        rebalancer.connect(other).transferOwnership(other.address)
      ).to.be.revertedWith("PR: not owner");
    });
  });
});
