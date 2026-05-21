// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseStrategy.sol";

/// @title Morpho Vault Interface (ERC-4626 compliant)
interface IMorphoVault {
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256);
    function maxWithdraw(address owner) external view returns (uint256);
    function asset() external view returns (address);
}

/// @title MorphoStrategy
/// @notice Strategy that deposits/withdraws from a Morpho Vault (ERC-4626 compliant).
///         Morpho Vaults are ERC-4626 wrappers around Morpho Blue markets.
contract MorphoStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    IMorphoVault public immutable morphoVault;

    constructor(
        address _asset,
        address _vault,
        address _management,
        address _keeper,
        address _emergencyAdmin,
        address _morphoVault
    ) BaseStrategy(_asset, _vault, _management, _keeper, _emergencyAdmin) {
        require(_morphoVault != address(0), "MS: zero morpho vault");
        morphoVault = IMorphoVault(_morphoVault);
        require(morphoVault.asset() == _asset, "MS: asset mismatch");
        // Approve morpho vault to spend asset
        IERC20(_asset).forceApprove(_morphoVault, type(uint256).max);
    }

    function _deployFunds(uint256 amount) internal override {
        morphoVault.deposit(amount, address(this));
    }

    function _freeFunds(uint256 amount) internal override {
        morphoVault.withdraw(amount, address(this), address(this));
    }

    function _harvestAndReport() internal override returns (uint256) {
        return morphoVault.convertToAssets(morphoVault.balanceOf(address(this)));
    }

    function _totalAssets() internal view override returns (uint256) {
        return morphoVault.convertToAssets(morphoVault.balanceOf(address(this)));
    }

    /// @notice Emergency: withdraw all from Morpho back to vault
    function emergencyWithdrawAll() external onlyEmergencyAdmin {
        uint256 shares = morphoVault.balanceOf(address(this));
        if (shares > 0) {
            morphoVault.redeem(shares, vault, address(this));
        }
    }
}
