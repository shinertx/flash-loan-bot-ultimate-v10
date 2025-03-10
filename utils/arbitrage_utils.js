#!/usr/bin/env node
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
//Not needed.
// function calculateTriangularArbitrage(amountIn, reserveInA, reserveOutA, reserveInB, reserveOutB, reserveInC, reserveOutC) {
//     const amountOutB = calculateUniswapV2Output(amountIn, reserveInA, reserveOutA);
//     const amountOutC = calculateUniswapV2Output(amountOutB, reserveInB, reserveOutB);
//     const finalAmountA = calculateUniswapV2Output(amountOutC, reserveInC, reserveOutC);

//     return finalAmountA - BigInt(amountIn);
// }

module.exports = {
    calculateUniswapV2Output,
    calculateUniswapV2Input,
    // calculateTriangularArbitrage // Export the function
};
