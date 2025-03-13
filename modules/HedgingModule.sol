// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IERC20.sol";
import "../interfaces/IUniswapV2Router02.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract HedgingModule is Ownable {
    using SafeERC20 for IERC20;

    address public immutable dai;
    address public immutable weth;
    address public immutable uniswapRouter;

    event HedgeExecuted(address indexed tokenSold, address indexed tokenBought, uint256 amountSold, uint256 amountReceived);

    constructor(address _dai, address _weth, address _uniswapRouter) {
        dai = _dai;
        weth = _weth;
        uniswapRouter = _uniswapRouter;
    }

    function executeHedge(uint256 daiAmount, uint256 hedgePercentage) external onlyOwner {
        require(hedgePercentage <= 100, "hedge > 100%");
        uint256 amountToSwap = (daiAmount * hedgePercentage) / 100;
        if(amountToSwap == 0) return;

        IERC20(dai).safeApprove(uniswapRouter, 0);
        IERC20(dai).safeApprove(uniswapRouter, amountToSwap);

        address[] memory path = new address[](2);
        path[0] = dai;
        path[1] = weth;

        // 1% slip
        uint256[] memory amountsOut = IUniswapV2Router02(uniswapRouter).getAmountsOut(amountToSwap, path);
        uint256 minOut = (amountsOut[1]*99)/100;

        uint256[] memory results = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            amountToSwap,
            minOut,
            path,
            address(this),
            block.timestamp
        );

        emit HedgeExecuted(dai, weth, amountToSwap, results[1]);
    }

    function withdraw(address _token, address _recipient, uint256 _amount) external onlyOwner {
        IERC20(_token).safeTransfer(_recipient, _amount);
    }
    function withdrawAll(address _token, address _recipient) external onlyOwner {
        uint256 bal = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(_recipient, bal);
    }
}
