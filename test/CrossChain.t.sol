// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../contracts/MegaFlashBot.sol";
import "../contracts/modules/BridgeModule.sol";
import "../contracts/interfaces/IAxelarGateway.sol";
import "../contracts/interfaces/IERC20.sol";


// Mock ERC20 for testing
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

// Mock Axelar Gateway
contract MockAxelarGateway is IAxelarGateway {
    event ContractCall(string  destinationChain, string  contractAddress, bytes payload);

    function callContract(string calldata destinationChain, string calldata contractAddress, bytes calldata payload) external override {
        // In a real deployment, this would send a message to the Axelar network.
        // For testing, we just emit an event.
        emit ContractCall(destinationChain, contractAddress, payload);
    }
}


contract CrossChainTest is Test {
    MegaFlashBot bot;
    BridgeModule bridge;
    MockAxelarGateway mockAxelarGateway;
    MockERC20 mockDAI;
    address owner = address(this);  // Or use vm.addr(1) for a different address
    address public constant UNISWAP_V2_ROUTER = address(0x123);  // Mock router

    function setUp() public {
        // Deploy a mock DAI token
        mockDAI = new MockERC20("DAI", "DAI");

        // Deploy the mock Axelar Gateway
        mockAxelarGateway = new MockAxelarGateway();

        // Deploy the BridgeModule, passing the mock gateway and DAI token
        bridge = new BridgeModule(address(mockAxelarGateway), address(mockDAI));

        // Deploy MegaFlashBot, passing in dummy addresses for now.
        // We don't need real DEXes or oracles for *this* test.
        bot = new MegaFlashBot(
            address(0x456),  // Mock lending pool
            UNISWAP_V2_ROUTER,
            address(mockDAI),
            100, // flashLoanPremium (example value)
            100, // slippageTolerance (example value)
            address(0x789),  // Mock Chainlink oracle
            owner //owner
        );

         // Set the bridge module in MegaFlashBot
        vm.prank(owner); //Do as owner from now on.
        bot.setBridgeModule(address(bridge));

        // Mint some DAI to the bot for testing
        mockDAI._mint(address(bot), 10000 ether);  // Give the bot some initial DAI

        //Set destination (as example)
        bridge.setDestination("Ethereum", "0xContractAddress");
    }
    function testBridgeTokens() public {
        uint256 amountToBridge = 500 ether;

        // Approve the BridgeModule to spend the bot's DAI
        vm.startPrank(address(bot));  // Call subsequent functions *from* the bot contract
        IERC20(mockDAI).approve(address(bridge), amountToBridge);
        vm.stopPrank();

        // Expect the ContractCall event from the mock Axelar Gateway
        vm.expectEmit(true, true, true, true, address(mockAxelarGateway));
        emit ContractCall(
            bridge.destinationChain(),
            bridge.destinationAddress(),
            abi.encode(address(mockDAI), amountToBridge, address(bot)) // Expected payload
        );

        // Call bridgeTokens on the bot *through* the owner (since it's onlyOwner)
        vm.prank(owner);
        bot.executeCrossChainArbitrage(address(mockDAI), amountToBridge);


        // Verify that DAI allowance for the bridge is 0 after (best practice)
        assertEq(IERC20(mockDAI).allowance(address(bot), address(bridge)), 0, "Allowance not reset");
    }

    function testBridgeTokens_NoBridge() public {
        vm.prank(owner);
        bot.setBridgeModule(address(0));
        vm.expectRevert("No BridgeModule set");
        vm.prank(owner);
        bot.executeCrossChainArbitrage(address(mockDAI), 100);
    }

      function testBridgeTokens_ZeroAmount() public {
        // Bridging zero amount should not revert, but shouldn't call axelar either

        vm.expectEmit(false, false, false, false, address(mockAxelarGateway)); // No events = not called.
        vm.startPrank(address(bot));  // Approve from the bot contract
        IERC20(mockDAI).approve(address(bridge), 0);
        vm.stopPrank();

        vm.prank(owner);
        bot.executeCrossChainArbitrage(address(mockDAI), 0);

        assertEq(IERC20(mockDAI).allowance(address(bot), address(bridge)), 0, "Allowance not zero after 0 amount.");
    }
}
