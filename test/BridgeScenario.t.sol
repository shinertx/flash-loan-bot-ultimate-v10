// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/MegaFlashBot.sol";
import "../contracts/modules/BridgeModule.sol";
import "../contracts/modules/MEVModule.sol";
import "../contracts/modules/HedgingModule.sol";
import "../contracts/interfaces/IERC20.sol";

// Mock Aave
contract MockAavePool {
    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external {
        IFlashLoanSimpleReceiver(receiver).executeOperation(asset, amount, 10, address(this), params); // Mock premium
    }
}

contract MockAxelarGateway {
    event CallContract(string destinationChain, string contractAddress, bytes payload);
     function callContract(string calldata destinationChain, string calldata contractAddress, bytes calldata payload) external {
        emit CallContract(destinationChain, contractAddress, payload);
    }
}

contract BridgeScenarioTest is Test {
    MegaFlashBot bot;
    BridgeModule bridge;
    MockAavePool mockPool;
    MockAxelarGateway mockAxelarGateway;
    MockERC20 mockDAI;
    MockERC20 mockWETH;
    address owner = address(this);
    address uniswapRouter = address(0x456);


    function setUp() public {
        // Deploy mock
        mockPool = new MockAavePool();
        mockAxelarGateway = new MockAxelarGateway();
        // Deploy DAI mock
        mockDAI = new MockERC20("DAI", "DAI");
        mockWETH = new MockERC20("WETH", "WETH");
        // Deploy Bridge
        bridge = new BridgeModule(address(mockAxelarGateway), address(mockDAI));
        // Deploy Bot
        bot = new MegaFlashBot(
            address(mockPool),
            uniswapRouter,
            address(mockDAI),
            100,
            50,
            address(0x0), //chainlink oracle
            owner
        );

        vm.label(address(mockDAI), "DAI");
        vm.label(address(mockWETH), "WETH");
        vm.label(address(bot), "MegaFlashBot");
        vm.label(address(bridge), "BridgeModule");
        vm.label(owner, "Owner");

        bot.transferOwnership(owner);
        // set Bridge
        bot.setBridgeModule(address(bridge));

        //Mint and give dai to bot.
        mockDAI.mint(address(bot), 10000 ether);

    }

     function testAxelarCall() public {
        // Set up for a cross-chain call (example values)
        address testToken = address(mockDAI); //  Use a mock token
        uint256 testAmount = 100 ether;

        // Expect the AxelarGateway to be called
        vm.expectCall(address(mockAxelarGateway), abi.encodeWithSelector(MockAxelarGateway.callContract.selector));
        vm.expectEmit(true, true, true, true);

        // Call executeCrossChainArbitrage
        vm.prank(owner);
        bot.executeCrossChainArbitrage(testToken, testAmount);
    }

    function testSuccessfulBridgeAfterProfit() public {
        uint256 flashLoanAmount = 1000 ether;
        uint256 amountOut = 1100 ether; // Simulate profit
        // Mock the uniswap call.
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, flashLoanAmount, new address[](2)),
            abi.encode(new uint256[](2)) // Empty return for void function
        );

        // Mock the uniswap call.
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.swapExactTokensForTokens.selector),
            abi.encode(new uint256[](2)) // Empty return for void function
        );

        //Approve mock
         vm.mockCall(
            address(mockDAI),
            abi.encodeWithSelector(IERC20.approve.selector),
            abi.encode(true)
        );
        vm.expectEmit(true, true, true, true);
        emit bot.BridgeExecuted(address(mockDAI), 545 ether); // Expected bridge amount (50%)

         vm.expectCall(address(mockAxelarGateway), abi.encodeWithSelector(MockAxelarGateway.callContract.selector));

        vm.prank(owner); // Only owner
        bot.executeFlashLoan(flashLoanAmount, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);

    }

}

// Minimal mock for the test - You can expand this
contract MockToken is IERC20 {
    mapping(address => uint256) private _balances;
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }
    function totalSupply() external view override returns (uint256) {
        return 1000000 ether;
    }
    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }
    function transfer(address to, uint256 amount) external override returns (bool) {
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }
    function approve(address, uint256) external pure override returns(bool){
        return true;
    }
    function transferFrom(address, address, uint256) external pure override returns(bool){
        return true;
    }
    function allowance(address, address) external pure override returns(uint256){
        return 10000 ether;
    }
    function mint(address to, uint256 amt) external {
        _balances[to] += amt;
    }

}
