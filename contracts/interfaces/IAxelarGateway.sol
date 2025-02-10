pragma solidity ^0.8.19;

interface IAxelarGateway {
    function callContract(string calldata destinationChain, string calldata contractAddress, bytes calldata payload) external;
}

