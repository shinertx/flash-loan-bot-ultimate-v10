// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../contracts/interfaces/IERC20.sol";
import "../contracts/interfaces/IAxelarGateway.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract BridgeModule is Ownable {
    using SafeERC20 for IERC20;

    address public axelarGateway;
    address public dai;

    constructor(address _axelarGateway, address _dai) {
        axelarGateway = _axelarGateway;
        dai = _dai;
    }

    function bridgeTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeApprove(axelarGateway, amount);
        IAxelarGateway(axelarGateway).callContract(
            "destinationChain",
            "0xRecipientOnDestChain", // Replace with the actual destination contract
            abi.encode(token, amount)
        );
    }
}

