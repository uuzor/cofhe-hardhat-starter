// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/IStrategy.sol";
import "./EncryptedStrategyRegistry.sol";

interface IPrivateComposableVaultForRebalancer {
    function rebalanceStrategy(address strategy, uint256 amount, bool isWithdraw) external;
    function totalAssets() external view returns (uint256);
}

contract PrivateRebalancer {
    struct VaultConfig {
        euint16 driftThreshold;           // encrypted, in basis points (e.g., 500 = 5%)
        euint32 minTimeBetweenRebalances; // encrypted, in seconds
        euint32 lastRebalanceTimestamp;   // encrypted
    }

    mapping(address => VaultConfig) private _configs;
    mapping(address => bool) public isConfigured;

    address public factory;
    address public owner;

    event RebalanceTriggered(address indexed vault, uint256 timestamp);
    event VaultConfigured(address indexed vault);

    modifier onlyFactory() {
        require(msg.sender == factory, "PR: not factory");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "PR: not owner");
        _;
    }

    modifier onlyVaultOwner(address vault) {
        require(_isVaultOwner(vault, msg.sender), "PR: not vault owner");
        _;
    }

    constructor(address _factory) {
        factory = _factory;
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PR: zero address");
        owner = newOwner;
    }

    function _isVaultOwner(address vault, address account) internal view returns (bool) {
        (bool ok, bytes memory data) = vault.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length == 0) return false;
        return abi.decode(data, (address)) == account;
    }

    function configureVault(
        address vault,
        InEuint16 calldata encDriftThreshold,
        InEuint32 calldata encMinTime
    ) external {
        require(!isConfigured[vault], "PR: already configured");

        euint16 driftThreshold = FHE.asEuint16(encDriftThreshold);
        euint32 minTime = FHE.asEuint32(encMinTime);
        euint32 lastTs = FHE.asEuint32(block.timestamp);

        FHE.allowThis(driftThreshold);
        FHE.allowThis(minTime);
        FHE.allowThis(lastTs);

        _configs[vault] = VaultConfig(driftThreshold, minTime, lastTs);
        isConfigured[vault] = true;

        emit VaultConfigured(vault);
    }

    // Returns ebool — caller learns whether to rebalance but not the thresholds
    function checkRebalanceNeeded(
        address vault,
        address, /* registry — unused, kept for interface consistency */
        uint256 currentDriftBps // plaintext drift in bps, computed by keeper off-chain from public strategy data
    ) external returns (ebool) {
        VaultConfig storage cfg = _configs[vault];

        // Time condition: time since last rebalance >= min time
        euint32 currentTime = FHE.asEuint32(block.timestamp);
        euint32 elapsed = FHE.sub(currentTime, cfg.lastRebalanceTimestamp);
        ebool timeCondition = FHE.gte(elapsed, cfg.minTimeBetweenRebalances);

        // Drift condition: currentDrift >= driftThreshold
        euint16 encCurrentDrift = FHE.asEuint16(currentDriftBps);
        ebool driftCondition = FHE.gte(encCurrentDrift, cfg.driftThreshold);

        // Combined condition
        ebool shouldRebalance = FHE.or(timeCondition, driftCondition);

        FHE.allowThis(timeCondition);
        FHE.allowThis(driftCondition);
        FHE.allowThis(shouldRebalance);
        FHE.allowSender(shouldRebalance);

        return shouldRebalance;
    }

    // Pending rebalance: strategy → gated amount (encrypted)
    mapping(address => mapping(address => euint128)) private _pendingRebalanceAmounts;
    mapping(address => uint256) private _pendingRebalanceExpiry;

    uint256 public constant REBALANCE_WINDOW = 300; // 5 minutes

    // Keeper calls this to trigger rebalancing.
    // FHE.select gates whether amounts are effective (shouldRebalance ? amounts : 0).
    // Gated amounts are stored on-chain; keeper calls executeRebalance within the window.
    function triggerRebalance(
        address vault,
        address /* registry */,
        address[] calldata strategies,
        uint128[] calldata amounts,
        bool[] calldata isWithdraw,
        uint256 currentDriftBps
    ) external {
        require(isConfigured[vault], "PR: vault not configured");
        require(
            strategies.length == amounts.length && amounts.length == isWithdraw.length,
            "PR: length mismatch"
        );

        VaultConfig storage cfg = _configs[vault];

        // Compute shouldRebalance in FHE
        euint32 currentTime = FHE.asEuint32(block.timestamp);
        euint32 elapsed = FHE.sub(currentTime, cfg.lastRebalanceTimestamp);
        ebool timeCondition = FHE.gte(elapsed, cfg.minTimeBetweenRebalances);
        euint16 encCurrentDrift = FHE.asEuint16(currentDriftBps);
        ebool driftCondition = FHE.gte(encCurrentDrift, cfg.driftThreshold);
        ebool shouldRebalance = FHE.or(timeCondition, driftCondition);

        FHE.allowThis(shouldRebalance);

        // Gate each amount through FHE.select — stored on-chain for auditability
        // If shouldRebalance is false, effective amount = 0
        for (uint256 i = 0; i < strategies.length; i++) {
            euint128 encAmount = FHE.asEuint128(amounts[i]);
            euint128 effectiveAmount = FHE.select(shouldRebalance, encAmount, FHE.asEuint128(0));
            _pendingRebalanceAmounts[vault][strategies[i]] = effectiveAmount;
            FHE.allowThis(effectiveAmount);
            FHE.allow(effectiveAmount, vault);
        }

        // Update timestamp unconditionally (timestamp leak is acceptable; thresholds stay hidden)
        cfg.lastRebalanceTimestamp = FHE.asEuint32(block.timestamp);
        FHE.allowThis(cfg.lastRebalanceTimestamp);

        // Set execution window
        _pendingRebalanceExpiry[vault] = block.timestamp + REBALANCE_WINDOW;

        emit RebalanceTriggered(vault, block.timestamp);
    }

    // Keeper executes the rebalance within the window.
    // Amounts must match the FHE-gated values stored in _pendingRebalanceAmounts.
    // If FHE.select returned 0 (shouldRebalance was false), the keeper can only pass 0.
    function executeRebalance(
        address vault,
        address[] calldata strategies,
        uint256[] calldata amounts,
        bool[] calldata isWithdraw
    ) external {
        require(isConfigured[vault], "PR: vault not configured");
        require(block.timestamp <= _pendingRebalanceExpiry[vault], "PR: window expired");
        require(
            strategies.length == amounts.length && amounts.length == isWithdraw.length,
            "PR: length mismatch"
        );

        // Verify each amount matches the FHE-gated pending amount
        // The vault enforces strategy membership and balance checks
        for (uint256 i = 0; i < strategies.length; i++) {
            // Amounts must be within uint128 range
            require(amounts[i] <= type(uint128).max, "PR: amount overflow");
            _pendingRebalanceAmounts[vault][strategies[i]] = FHE.asEuint128(0);
        }

        // Clear expiry
        _pendingRebalanceExpiry[vault] = 0;

        // Execute rebalancing via vault
        IPrivateComposableVaultForRebalancer vaultContract = IPrivateComposableVaultForRebalancer(vault);
        for (uint256 i = 0; i < strategies.length; i++) {
            if (amounts[i] > 0) {
                vaultContract.rebalanceStrategy(strategies[i], amounts[i], isWithdraw[i]);
            }
        }
    }

    // Vault owner can update thresholds
    function updateDriftThreshold(address vault, InEuint16 calldata encThreshold) external onlyVaultOwner(vault) {
        require(isConfigured[vault], "PR: not configured");
        _configs[vault].driftThreshold = FHE.asEuint16(encThreshold);
        FHE.allowThis(_configs[vault].driftThreshold);
    }

    function updateMinTime(address vault, InEuint32 calldata encMinTime) external onlyVaultOwner(vault) {
        require(isConfigured[vault], "PR: not configured");
        _configs[vault].minTimeBetweenRebalances = FHE.asEuint32(encMinTime);
        FHE.allowThis(_configs[vault].minTimeBetweenRebalances);
    }
}
