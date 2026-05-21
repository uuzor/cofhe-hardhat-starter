// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockMorphoVault
/// @notice Mock Morpho vault (ERC-4626) that simulates yield for testing.
///         Mimics a Morpho Blue market wrapper with linear yield accrual.
contract MockMorphoVault is ERC4626 {
    uint256 public yieldRate; // basis points per report cycle
    uint256 public reportCount;

    constructor(address asset_, string memory name_, string memory symbol_, uint256 _yieldRate)
        ERC4626(IERC20(asset_))
        ERC20(name_, symbol_)
    {
        yieldRate = _yieldRate;
    }

    /// @notice Total assets = actual balance + accrued yield
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + _accruedYield();
    }

    function _accruedYield() internal view returns (uint256) {
        // Simplified: linear yield per report cycle
        uint256 base = IERC20(asset()).balanceOf(address(this));
        return base * yieldRate * reportCount / 10_000;
    }

    /// @notice Simulate a report cycle (accrues yield)
    function reportYield() external {
        reportCount++;
    }

    /// @notice Set yield rate (bps)
    function setYieldRate(uint256 _yieldRate) external {
        yieldRate = _yieldRate;
    }

    /// @notice Mint test tokens to the vault (simulates external yield)
    function mintToVault(uint256 amount) external {
        IERC20(asset()).transferFrom(msg.sender, address(this), amount);
    }
}
