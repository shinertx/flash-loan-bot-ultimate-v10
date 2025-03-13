// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IERC20.sol";
import "../interfaces/IAxelarGateway.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract BridgeModule is Ownable {
    using SafeERC20 for IERC20;

    address public axelarGateway;
    address public dai;

    string public destinationChain = "Moonbeam"; 
    string public destinationAddress = "0xRecipientOnDestChain";

    constructor(address _axelarGateway, address _dai) {
        axelarGateway = _axelarGateway;
        dai = _dai;
    }

    function setDestinationChain(string calldata chain, string calldata contractAddr) external onlyOwner {
        destinationChain = chain;
        destinationAddress = contractAddr;
    }

    function bridgeTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeApprove(axelarGateway, 0);
        IERC20(token).safeApprove(axelarGateway, amount);

        IAxelarGateway(axelarGateway).callContract(
            destinationChain,
            destinationAddress,
            abi.encode(token, amount)
        );
    }
}
