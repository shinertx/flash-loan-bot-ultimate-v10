function calculateUniswapV2Output(amountIn, reserveIn, reserveOut) {
    const amountInWithFee = BigInt(amountIn) * 997n;
    const numerator = amountInWithFee * BigInt(reserveOut);
    const denominator = BigInt(reserveIn) * 1000n + amountInWithFee;
    return numerator / denominator;
}

function calculateUniswapV2Input(amountOut, reserveIn, reserveOut) {
    const numerator = BigInt(reserveIn) * BigInt(amountOut) * 1000n;
    const denominator = (BigInt(reserveOut) - BigInt(amountOut)) * 997n;
    return (numerator / denominator) + 1n;
}

module.exports = {
    calculateUniswapV2Output,
    calculateUniswapV2Input
};

