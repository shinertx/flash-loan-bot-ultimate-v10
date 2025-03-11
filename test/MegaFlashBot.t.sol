// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/MegaFlashBot.sol";
import "../contracts/interfaces/IUniswapV2Router02.sol";
import "../contracts/interfaces/IERC20.sol";

contract MockAavePool {
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external {
        IFlashLoanSimpleReceiver(receiver).executeOperation(asset, amount, 10, receiver, params); // Mock premium
    }
}
//Added Mock Token for testing.
contract MockERC20 is IERC20 {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;
    string public name;
    string public symbol;
    uint8 public decimals;
    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        decimals = 18;
    }
    function totalSupply() public view override returns (uint256) {
        return _totalSupply;
    }
    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }
    function transfer(address recipient, uint256 amount) public override returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }
    function allowance(address owner, address spender) public view override returns (uint256) {
        return _allowances[owner][spender];
    }
    function approve(address spender, uint256 amount) public override returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        _transfer(sender, recipient, amount);
        _approve(sender, msg.sender, _allowances[sender][msg.sender] - amount);
        return true;
    }
    function _transfer(address sender, address recipient, uint256 amount) internal {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");
        _balances[sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(sender, recipient, amount);
    }
    function _mint(address account, uint256 amount) internal {
        require(account != address(0), "ERC20: mint to the zero address");
        _totalSupply += amount;
        _balances[account] += amount;
        emit Transfer(address(0), account, amount);
    }
    function _approve(address owner, address spender, uint256 amount) internal {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");
        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }
}

contract MegaFlashBotTest is Test {
    MegaFlashBot bot;
    MockAavePool mockPool;
    MockERC20 mockDAI;
    MockERC20 mockWETH;
    MockERC20 mockUNI;
    address owner = address(this);
    address uniswapRouter = address(0x123); // Mock router address

    function setUp() public {
        mockDAI = new MockERC20("DAI", "DAI");
        mockWETH = new MockERC20("WETH", "WETH");
        mockUNI = new MockERC20("UNI" , "UNI");
		mockDAI._mint(address(this), 1000000 ether); // Mint DAI and weth to this for testing.
        mockWETH._mint(address(this), 1000000 ether);
        mockUNI._mint(address(this), 1000000 ether);
        mockPool = new MockAavePool();
        bot = new MegaFlashBot(address(mockPool), uniswapRouter, address(mockDAI), 100, 50, address(0), address(this));
        bot.transferOwnership(owner);
		mockDAI.transfer(address(bot), 100000 ether); //fund bot for premium
    }


    function testSuccessfulTwoTokenTrade() public {
        uint256 flashLoanAmount = 1000 ether;
        uint256 amountOut = 1100 ether; // Simulate profit

        // Mock Uniswap getAmountsOut to return a profitable result
        bytes memory encodedReturn = abi.encode(new uint256[](2));
        encodedReturn[0] = flashLoanAmount; //amount in
		encodedReturn[1] = amountOut;  //amount out

        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, flashLoanAmount, new address[](2)),
            encodedReturn
        );

        // Mock Uniswap swapExactTokensForTokens (no actual transfer needed in mock)
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.swapExactTokensForTokens.selector),
            abi.encode(new uint256[](2)) // Empty return for void function
        );

		//approve
		vm.mockCall(
            address(mockDAI),
            abi.encodeWithSelector(IERC20.approve.selector),
            abi.encode(true)
        );


        // Execute the flash loan
        vm.expectEmit(true, true, true, true);
        emit TradeExecuted(flashLoanAmount, amountOut - flashLoanAmount - 10); // Expected profit (minus premium)
        bot.executeFlashLoan(flashLoanAmount, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);

    }
	  function testSuccessfulThreeTokenTrade() public {
        // Setup amounts for a profitable triangular arbitrage
        uint256 flashLoanAmount = 1000 ether;
        uint256 amountOutB = 5 ether;       // Example: 1000 DAI -> 5 WETH
        uint256 amountOutC = 100000000000;  // Example: 5 WETH -> 100 UNI
        uint256 amountOutA = 1010 ether;     // Example: 100 UNI -> 1010 DAI

        // Mock getAmountsOut for each leg of the triangular arbitrage
        bytes memory encodedReturnAB = abi.encode(new uint256[](2));
		encodedReturnAB[0] = flashLoanAmount;
		encodedReturnAB[1] = amountOutB;
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, flashLoanAmount, new address[](2)),
            encodedReturnAB
        );
		bytes memory encodedReturnBC = abi.encode(new uint256[](2));
		encodedReturnBC[0] = amountOutB;
		encodedReturnBC[1] = amountOutC;
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, amountOutB, new address[](2)),
             encodedReturnBC
        );
		bytes memory encodedReturnCA = abi.encode(new uint256[](2));
		encodedReturnCA[0] = amountOutC;
		encodedReturnCA[1] = amountOutA;
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, amountOutC, new address[](2)),
            encodedReturnCA
        );

        // Mock swapExactTokensForTokens (no actual transfer needed in mock)
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.swapExactTokensForTokens.selector),
            abi.encode(new uint256[](2))  // Empty return
        );
		//approve
		vm.mockCall(
            address(mockDAI),
            abi.encodeWithSelector(IERC20.approve.selector),
            abi.encode(true)
        );

        // Execute the triangular arbitrage flash loan
        vm.expectEmit(true, true, true, true);

        emit TradeExecuted(flashLoanAmount, amountOutA-flashLoanAmount-10); // Expected profit
        bot.executeFlashLoan(flashLoanAmount, address(mockDAI), address(mockWETH), address(mockUNI), MegaFlashBot.ArbitrageType.THREE_TOKEN, 50);
    }


    function testNoProfit() public {
        // Mock Uniswap to return a *non-profitable* result
         uint256 flashLoanAmount = 1000 ether;
        uint256 amountOut = 900 ether; // Simulate loss

        // Mock Uniswap getAmountsOut to return a profitable result
        bytes memory encodedReturn = abi.encode(new uint256[](2));
		encodedReturn[0] = flashLoanAmount;
		encodedReturn[1] = amountOut;
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, flashLoanAmount, new address[](2)),
            encodedReturn
        );
		//approve
		vm.mockCall(
            address(mockDAI),
            abi.encodeWithSelector(IERC20.approve.selector),
            abi.encode(true)
        );
        vm.expectRevert("InsufficientProfit"); // Now expecting the correct revert
        bot.executeFlashLoan(flashLoanAmount, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);
				vm.expectEmit(true, true, true, true); //we expect the NoProfit event emitted
				emit bot.NoProfit();

    }

    function testMaxSlippageExceeded() public {
        vm.expectRevert("MaxSlippageExceeded");
        bot.executeFlashLoan(1000e18, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 20000); // Set slippage above max
    }

    function testBlacklistedPair() public {
    // Blacklist the DAI/WETH pair using the correct function signature
    bot.blacklistPair(uniswapRouter, true);  // Use the router as a placeholder for the pair

    // Attempt to execute a flash loan with the blacklisted pair
    vm.expectRevert("Blacklisted pair"); // Expect the "Blacklisted pair" revert
    bot.executeFlashLoan(1000e18, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);
}


	  // NEW TEST: Insufficient Balance for Repayment
    function testInsufficientBalanceForRepayment() public {
        uint256 flashLoanAmount = 1000 ether;
        uint256 amountOut = 1009 ether; // Simulate barely not enough for repayment + premium

        // Mock getAmountsOut to return a slightly losing trade
        bytes memory encodedReturn = abi.encode(new uint256[](2));
        encodedReturn[0] = flashLoanAmount;
        encodedReturn[1] = amountOut;
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, flashLoanAmount, new address[](2)),
            encodedReturn
        );

        // Mock the swap call (no transfer occurs)
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.swapExactTokensForTokens.selector),
            abi.encode(new uint256[](2))
        );
			//approve
		vm.mockCall(
            address(mockDAI),
            abi.encodeWithSelector(IERC20.approve.selector),
            abi.encode(true)
        );

        // Expect the InsufficientBalance revert
        vm.expectRevert(abi.encodeWithSelector(bot.InsufficientBalance.selector, 1010 ether, 1009 ether));
        bot.executeFlashLoan(flashLoanAmount, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);
    }
	// NEW TEST: Validate Liquidity Reverts
    function testValidateLiquidityReverts() public {
		// Mock Uniswap to return a profitable result
		uint256 flashLoanAmount = 1000 ether;
        uint256 amountOut = 1100 ether; // Simulate profit
        bytes memory encodedReturn = abi.encode(new uint256[](2));
		encodedReturn[0] = flashLoanAmount;
		encodedReturn[1] = amountOut;
        vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.getAmountsOut.selector, flashLoanAmount, new address[](2)),
			encodedReturn
        );
		//mock the pair returning address(0)
		address mockFactory = address(0x456);
		  vm.mockCall(
            uniswapRouter,
            abi.encodeWithSelector(IUniswapV2Router02.factory.selector),
            abi.encode(mockFactory)
        );
		  vm.mockCall(
            mockFactory,
            abi.encodeWithSelector(IUniswapV2Router02.factory.selector,address(mockDAI), address(mockWETH)),
            abi.encode(address(0)) // Pair doesn't exist, returns address(0)
        );
        // Expect a revert
        vm.expectRevert();
        bot.executeFlashLoan(flashLoanAmount, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);
    }
		//Test circuit breaker and emergency.
	function testCircuitBreaker() public {
		// Set the circuit breaker
		bot.setCircuitBreaker(true);

		// Attempt a flash loan, should revert
		vm.expectRevert("Circuit breaker is active");
		bot.executeFlashLoan(1000e18, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);
	}

	function testEmergency() public {
		// Set emergency
		bot.setEmergency(true);

		// Attempt a flash loan, should revert
		vm.expectRevert("Emergency is active");
		bot.executeFlashLoan(1000e18, address(mockDAI), address(mockWETH), address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 50);
	}

}
