import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { Interface } from '@ethersproject/abi';
import { MaxUint256, WeiPerEther, Zero } from '@ethersproject/constants';

import { Swaps } from '@/modules/swaps/swaps.module';
import {
    BatchRelayerJoinPool,
    EncodeBatchSwapInput,
    EncodeExitPoolInput,
    EncodeJoinPoolInput,
    EncodeUnwrapAaveStaticTokenInput,
    EncodeUnwrapYearnVaultTokenInput,
    ExitAndBatchSwapInput,
    ExitPoolData,
    NestedLinearPool,
    OutputReference,
    UnwrapType,
} from './types';
import { BalancerSdkConfig, ExitPoolRequest, TransactionData } from '@/types';
import {
    BatchSwapStep,
    FetchPoolsInput,
    FundManagement,
    SwapType,
} from '../swaps/types';
import { SubgraphPoolBase } from '@balancer-labs/sor';

import relayerLibraryAbi from '@/lib/abi/VaultActions.json';
import aaveWrappingAbi from '@/lib/abi/AaveWrapping.json';
import yearnWrappingAbi from '@/lib/abi/YearnWrapping.json';
import { keyBy, sortBy } from 'lodash';
import { WeightedPoolEncoder } from '@/pool-weighted/encoder';

export * from './types';

export class Relayer {
    private readonly swaps: Swaps;

    static CHAINED_REFERENCE_PREFIX = 'ba10';

    constructor(swapsOrConfig: Swaps | BalancerSdkConfig) {
        if (swapsOrConfig instanceof Swaps) {
            this.swaps = swapsOrConfig;
        } else {
            this.swaps = new Swaps(swapsOrConfig);
        }
    }

    static encodeBatchSwap(params: EncodeBatchSwapInput): string {
        const relayerLibrary = new Interface(relayerLibraryAbi);

        return relayerLibrary.encodeFunctionData('batchSwap', [
            params.swapType,
            params.swaps,
            params.assets,
            params.funds,
            params.limits,
            params.deadline,
            params.value,
            params.outputReferences,
        ]);
    }

    static encodeExitPool(params: EncodeExitPoolInput): string {
        const relayerLibrary = new Interface(relayerLibraryAbi);

        return relayerLibrary.encodeFunctionData('exitPool', [
            params.poolId,
            params.poolKind,
            params.sender,
            params.recipient,
            params.exitPoolRequest,
            params.outputReferences,
        ]);
    }

    static encodeJoinPool(params: EncodeJoinPoolInput): string {
        const relayerLibrary = new Interface(relayerLibraryAbi);

        return relayerLibrary.encodeFunctionData('joinPool', [
            params.poolId,
            params.poolKind,
            params.sender,
            params.recipient,
            params.joinPoolRequest,
            params.value,
            params.outputReference,
        ]);
    }

    static encodeUnwrapAaveStaticToken(
        params: EncodeUnwrapAaveStaticTokenInput
    ): string {
        const aaveWrappingLibrary = new Interface(aaveWrappingAbi);

        return aaveWrappingLibrary.encodeFunctionData('unwrapAaveStaticToken', [
            params.staticToken,
            params.sender,
            params.recipient,
            params.amount,
            params.toUnderlying,
            params.outputReferences,
        ]);
    }

    static encodeUnwrapYearnVaultToken(
        params: EncodeUnwrapYearnVaultTokenInput
    ): string {
        const yearnWrappingLibrary = new Interface(yearnWrappingAbi);

        return yearnWrappingLibrary.encodeFunctionData(
            'unwrapYearnVaultToken',
            [
                params.vaultToken,
                params.sender,
                params.recipient,
                params.amount,
                params.outputReference,
            ]
        );
    }

    static toChainedReference(key: BigNumberish): BigNumber {
        // The full padded prefix is 66 characters long, with 64 hex characters and the 0x prefix.
        const paddedPrefix = `0x${Relayer.CHAINED_REFERENCE_PREFIX}${'0'.repeat(
            64 - Relayer.CHAINED_REFERENCE_PREFIX.length
        )}`;
        return BigNumber.from(paddedPrefix).add(key);
    }

    static constructExitCall(params: ExitPoolData): string {
        const {
            assets,
            minAmountsOut,
            userData,
            toInternalBalance,
            poolId,
            poolKind,
            sender,
            recipient,
            outputReferences,
        } = params;

        const exitPoolRequest: ExitPoolRequest = {
            assets,
            minAmountsOut,
            userData,
            toInternalBalance,
        };

        const exitPoolInput: EncodeExitPoolInput = {
            poolId,
            poolKind,
            sender,
            recipient,
            outputReferences,
            exitPoolRequest,
        };

        const exitEncoded = Relayer.encodeExitPool(exitPoolInput);
        return exitEncoded;
    }

    /**
     * fetchPools saves updated pools data to SOR internal onChainBalanceCache.
     * @param {SubgraphPoolBase[]} [poolsData=[]] If poolsData passed uses this as pools source otherwise fetches from config.subgraphUrl.
     * @param {boolean} [isOnChain=true] If isOnChain is true will retrieve all required onChain data via multicall otherwise uses subgraph values.
     * @returns {boolean} Boolean indicating whether pools data was fetched correctly (true) or not (false).
     */
    async fetchPools(): Promise<boolean> {
        return this.swaps.fetchPools();
    }

    public getPools(): SubgraphPoolBase[] {
        return this.swaps.getPools();
    }

    private get poolMap(): { [address: string]: SubgraphPoolBase } {
        const pools = this.getPools();

        return keyBy(pools, 'address');
    }

    private get linearPoolMap(): { [address: string]: SubgraphPoolBase } {
        const pools = this.getPools();

        return keyBy(
            pools.filter((pool) => pool.poolType === 'Linear'),
            'address'
        );
    }

    private get stablePhantomMap(): { [address: string]: SubgraphPoolBase } {
        const pools = this.getPools();

        return keyBy(
            pools.filter((pool) => pool.poolType === 'StablePhantom'),
            'address'
        );
    }

    /**
     * exitPoolAndBatchSwap Chains poolExit with batchSwap to final tokens.
     * @param {ExitAndBatchSwapInput} params
     * @param {string} exiter - Address used to exit pool.
     * @param {string} swapRecipient - Address that receives final tokens.
     * @param {string} poolId - Id of pool being exited.
     * @param {string[]} exitTokens - Array containing addresses of tokens to receive after exiting pool. (must have the same length and order as the array returned by `getPoolTokens`.)
     * @param {string} userData - Encoded exitPool data.
     * @param {string[]} expectedAmountsOut - Expected amounts of exitTokens to receive when exiting pool.
     * @param {string[]} finalTokensOut - Array containing the addresses of the final tokens out.
     * @param {string} slippage - Slippage to be applied to swap section. i.e. 5%=50000000000000000.
     * @param {FetchPoolsInput} fetchPools - Set whether SOR will fetch updated pool info.
     * @returns Transaction data with calldata. Outputs.amountsOut has amounts of finalTokensOut returned.
     */
    async exitPoolAndBatchSwap(
        params: ExitAndBatchSwapInput
    ): Promise<TransactionData> {
        const slippageAmountNegative = WeiPerEther.sub(
            BigNumber.from(params.slippage)
        );
        // Set min amounts out of exit pool based on slippage
        const minAmountsOut = params.expectedAmountsOut.map((amt) =>
            BigNumber.from(amt)
                .mul(slippageAmountNegative)
                .div(WeiPerEther)
                .toString()
        );

        // Output of exit is used as input to swaps
        const outputReferences: OutputReference[] = [];
        params.exitTokens.forEach((asset, i) => {
            const key = Relayer.toChainedReference(i);
            outputReferences.push({
                index: i,
                key: key,
            });
        });

        const exitCall = Relayer.constructExitCall({
            assets: params.exitTokens,
            minAmountsOut,
            userData: params.userData,
            toInternalBalance: true, // Creates exitPool request with exit to internal balance to save gas for following swaps
            poolId: params.poolId,
            poolKind: 0, // This will always be 0 to match supported Relayer types
            sender: params.exiter,
            recipient: params.exiter,
            outputReferences: outputReferences,
            exitPoolRequest: {} as ExitPoolRequest,
        });

        // Use swapsService to get swap info for exitTokens>finalTokens
        // This will give batchSwap swap paths
        // Amounts out will be worst case amounts
        const queryResult = await this.swaps.queryBatchSwapWithSor({
            tokensIn: params.exitTokens,
            tokensOut: params.finalTokensOut,
            swapType: SwapType.SwapExactIn,
            amounts: minAmountsOut, // Use minAmountsOut as input to swap to account for slippage
            fetchPools: params.fetchPools,
        });

        // Update swap amounts with ref outputs from exitPool
        queryResult.swaps.forEach((swap) => {
            const token = queryResult.assets[swap.assetInIndex];
            const index = params.exitTokens.indexOf(token);
            if (index !== -1)
                swap.amount = outputReferences[index].key.toString();
        });

        // const tempDeltas = ['10096980', '0', '0', '10199896999999482390', '0']; // Useful for debug

        // Replace tokenIn delta for swaps with amount + slippage.
        // This gives tolerance for limit incase amount out of exitPool is larger min,
        const slippageAmountPositive = WeiPerEther.add(params.slippage);
        params.exitTokens.forEach((exitToken, i) => {
            const index = queryResult.assets
                .map((elem) => elem.toLowerCase())
                .indexOf(exitToken.toLowerCase());
            if (index !== -1) {
                queryResult.deltas[index] = BigNumber.from(
                    params.expectedAmountsOut[i]
                )
                    .mul(slippageAmountPositive)
                    .div(WeiPerEther)
                    .toString();
            }
        });

        // Creates limit array.
        // Slippage set to 0. Already accounted for as swap used amounts out of pool with worst case slippage.
        const limits = Swaps.getLimitsForSlippage(
            params.exitTokens, // tokensIn
            params.finalTokensOut, // tokensOut
            SwapType.SwapExactIn,
            queryResult.deltas, // tempDeltas // Useful for debug
            queryResult.assets,
            '0'
        );

        // Creates fund management using internal balance as source of tokens
        const funds: FundManagement = {
            sender: params.exiter,
            recipient: params.swapRecipient,
            fromInternalBalance: true,
            toInternalBalance: false,
        };

        const encodedBatchSwap = Relayer.encodeBatchSwap({
            swapType: SwapType.SwapExactIn,
            swaps: queryResult.swaps,
            assets: queryResult.assets,
            funds: funds,
            limits: limits.map((l) => l.toString()),
            deadline: MaxUint256,
            value: '0',
            outputReferences: [],
        });

        // Return amounts from swap
        const calls = [exitCall, encodedBatchSwap];
        return {
            function: 'multicall',
            params: calls,
            outputs: {
                amountsOut: queryResult.returnAmounts,
            },
        };
    }

    async joinPool({
        poolId,
        joinType,
        tokens,
        bptOut,
        fetchPools,
        slippage,
        funds,
    }: BatchRelayerJoinPool): Promise<TransactionData> {
        const pool = this.getRequiredPool(poolId);
        const nestedLinearPools = this.getNestedLinearPools(pool);
        const calls: string[] = [];

        if (nestedLinearPools.length > 0) {
            //if there are nested linear pools, the first step is to swap mainTokens for linear or phantom stable BPT
            const tokensIn = nestedLinearPools.map((item) => item.mainToken);
            const tokensOut = nestedLinearPools.map(
                (item) => item.poolTokenAddress
            );
            const amounts = tokensIn.map((tokenAddress) => {
                const token = tokens.find(
                    (token) => token.address === tokenAddress
                );

                return token?.amount || '0';
            });

            const swapType =
                joinType === 'exact-in'
                    ? SwapType.SwapExactIn
                    : SwapType.SwapExactOut;

            const queryResult = await this.swaps.queryBatchSwapWithSor({
                tokensIn,
                tokensOut,
                swapType,
                amounts,
                fetchPools,
            });

            const limits = Swaps.getLimitsForSlippage(
                tokensIn,
                tokensOut,
                SwapType.SwapExactIn,
                queryResult.deltas,
                queryResult.assets,
                slippage
            );

            const encodedBatchSwap = Relayer.encodeBatchSwap({
                swapType,
                swaps: queryResult.swaps,
                assets: queryResult.assets,
                funds,
                limits: limits.map((l) => l.toString()),
                deadline: MaxUint256,
                value: '0', //TODO: this should represent native eth value
                outputReferences: queryResult.assets.map((asset, index) => ({
                    index,
                    key: Relayer.toChainedReference(index),
                })),
            });

            calls.push(encodedBatchSwap);
        }

        //if this is a weighted pool, we need to also join the pool
        if (pool.poolType === 'Weighted') {
            const amountsIn = pool.tokensList.map((tokenAddress) => {
                const token = tokens.find(
                    (token) => token.address === tokenAddress
                );

                if (token) {
                    return token.amount;
                }

                //This token is a nested BPT, not a mainToken
                //The max here will be replaced by the outputReference from the previous step
                return MaxUint256;
            });

            const encodedJoinPool = Relayer.encodeJoinPool({
                poolId: pool.id,
                poolKind: 0,
                sender: funds.sender,
                recipient: funds.recipient,
                joinPoolRequest: {
                    assets: pool.tokensList,
                    maxAmountsIn: amountsIn,
                    userData: WeightedPoolEncoder.joinExactTokensInForBPTOut(
                        amountsIn,
                        bptOut
                    ),
                    fromInternalBalance: funds.fromInternalBalance,
                },
                value: Zero, //TODO: if we support sending native eth, needs to be handled here
                outputReference: Zero,
            });

            calls.push(encodedJoinPool);
        }

        return {
            function: 'multicall',
            params: calls,
            outputs: {
                //amountsOut: amountsUnwrapped,
            },
        };
    }

    private getNestedLinearPools(pool: SubgraphPoolBase): NestedLinearPool[] {
        const linearPools: NestedLinearPool[] = [];

        for (const token of pool.tokensList) {
            if (this.linearPoolMap[token]) {
                const linearPool = this.linearPoolMap[token];
                const mainIdx = linearPool.mainIndex || 0;

                linearPools.push({
                    pool: linearPool,
                    mainToken: linearPool.tokensList[mainIdx],
                    poolTokenAddress: linearPool.address,
                });
            } else if (this.stablePhantomMap[token]) {
                for (const stablePhantomToken of this.stablePhantomMap[token]
                    .tokensList) {
                    if (this.linearPoolMap[stablePhantomToken]) {
                        const linearPool =
                            this.linearPoolMap[stablePhantomToken];
                        const mainIdx = linearPool.mainIndex || 0;

                        linearPools.push({
                            pool: linearPool,
                            mainToken: linearPool.tokensList[mainIdx],
                            poolTokenAddress:
                                this.stablePhantomMap[token].address,
                        });
                    }
                }
            }
        }

        return linearPools;
    }

    private getRequiredPool(poolId: string) {
        const pools = this.getPools();
        const pool = pools.find((pool) => pool.id === poolId);

        if (!pool) {
            throw new Error('No pool found with id: ' + poolId);
        }

        return pool;
    }

    /**
     * swapUnwrapExactIn Finds swaps for tokenIn>wrapped tokens and chains with unwrap to underlying stable.
     * @param {string[]} tokensIn - array to token addresses for swapping as tokens in.
     * @param {string[]} wrappedTokens - array contains the addresses of the wrapped tokens that tokenIn will be swapped to. These will be unwrapped.
     * @param {string[]} amountsIn - amounts to be swapped for each token in.
     * @param {string[]} rates - The rate used to convert wrappedToken to underlying.
     * @param {FundManagement} funds - Funding info for swap. Note - recipient should be relayer and sender should be caller.
     * @param {string} slippage - Slippage to be applied to swap section. i.e. 5%=50000000000000000.
     * @param {UnwrapType} unwrapType - Type of unwrap to perform
     * @param {FetchPoolsInput} fetchPools - Set whether SOR will fetch updated pool info.
     * @returns Transaction data with calldata. Outputs.amountsOut has final amounts out of unwrapped tokens.
     */
    async swapUnwrapExactIn(
        tokensIn: string[],
        wrappedTokens: string[],
        amountsIn: string[],
        rates: string[],
        funds: FundManagement,
        slippage: string,
        unwrapType: UnwrapType,
        fetchPools: FetchPoolsInput = {
            fetchPools: true,
            fetchOnChain: false,
        }
    ): Promise<TransactionData> {
        // Use swapsService to get swap info for tokensIn>wrappedTokens
        const queryResult = await this.swaps.queryBatchSwapWithSor({
            tokensIn,
            tokensOut: wrappedTokens,
            swapType: SwapType.SwapExactIn,
            amounts: amountsIn,
            fetchPools,
        });

        // Gets limits array for tokensIn>wrappedTokens based on input slippage
        const limits = Swaps.getLimitsForSlippage(
            tokensIn, // tokensIn
            wrappedTokens, // tokensOut
            SwapType.SwapExactIn,
            queryResult.deltas,
            queryResult.assets,
            slippage
        );

        const calls = this.encodeSwapUnwrap(
            wrappedTokens,
            SwapType.SwapExactIn,
            queryResult.swaps,
            queryResult.assets,
            funds,
            limits,
            unwrapType
        );

        const amountsUnwrapped = queryResult.returnAmounts.map(
            (amountWrapped, i) =>
                BigNumber.from(amountWrapped)
                    .abs()
                    .mul(rates[i])
                    .div(WeiPerEther)
                    .toString()
        );

        return {
            function: 'multicall',
            params: calls,
            outputs: {
                amountsOut: amountsUnwrapped,
            },
        };
    }

    /**
     * swapUnwrapExactOut Finds swaps for tokenIn>wrapped tokens and chains with unwrap to underlying stable.
     * @param {string[]} tokensIn - array to token addresses for swapping as tokens in.
     * @param {string[]} wrappedTokens - array contains the addresses of the wrapped tokens that tokenIn will be swapped to. These will be unwrapped.
     * @param {string[]} amountsUnwrapped - amounts of unwrapped tokens out.
     * @param {string[]} rates - The rate used to convert wrappedToken to underlying.
     * @param {FundManagement} funds - Funding info for swap. Note - recipient should be relayer and sender should be caller.
     * @param {string} slippage - Slippage to be applied to swap section. i.e. 5%=50000000000000000.
     * @param {UnwrapType} unwrapType - Type of unwrap to perform
     * @param {FetchPoolsInput} fetchPools - Set whether SOR will fetch updated pool info.
     * @returns Transaction data with calldata. Outputs.amountsIn has the amounts of tokensIn.
     */
    async swapUnwrapExactOut(
        tokensIn: string[],
        wrappedTokens: string[],
        amountsUnwrapped: string[],
        rates: string[],
        funds: FundManagement,
        slippage: string,
        unwrapType: UnwrapType,
        fetchPools: FetchPoolsInput = {
            fetchPools: true,
            fetchOnChain: false,
        }
    ): Promise<TransactionData> {
        const amountsWrapped = amountsUnwrapped.map((amountInwrapped, i) =>
            BigNumber.from(amountInwrapped)
                .mul(WeiPerEther)
                .div(rates[i])
                .toString()
        );

        // Use swapsService to get swap info for tokensIn>wrappedTokens
        const queryResult = await this.swaps.queryBatchSwapWithSor({
            tokensIn,
            tokensOut: wrappedTokens,
            swapType: SwapType.SwapExactOut,
            amounts: amountsWrapped,
            fetchPools,
        });

        // Gets limits array for tokensIn>wrappedTokens based on input slippage
        const limits = Swaps.getLimitsForSlippage(
            tokensIn, // tokensIn
            wrappedTokens, // tokensOut
            SwapType.SwapExactOut,
            queryResult.deltas,
            queryResult.assets,
            slippage
        );

        const calls = this.encodeSwapUnwrap(
            wrappedTokens,
            SwapType.SwapExactOut,
            queryResult.swaps,
            queryResult.assets,
            funds,
            limits,
            unwrapType
        );

        return {
            function: 'multicall',
            params: calls,
            outputs: {
                amountsIn: queryResult.returnAmounts.map((amount) =>
                    amount.toString()
                ),
            },
        };
    }

    /**
     * Creates encoded multicalls using swap outputs as input amounts for token unwrap.
     * @param wrappedTokens
     * @param swapType
     * @param swaps
     * @param assets
     * @param funds
     * @param limits
     * @param unwrapType
     * @returns
     */
    encodeSwapUnwrap(
        wrappedTokens: string[],
        swapType: SwapType,
        swaps: BatchSwapStep[],
        assets: string[],
        funds: FundManagement,
        limits: BigNumberish[],
        unwrapType: UnwrapType
    ): string[] {
        // Output of swaps (wrappedTokens) is used as input to unwrap
        // Need indices of output tokens and outputReferences need to be made with those as key
        const outputReferences: OutputReference[] = [];
        const unwrapCalls: string[] = [];
        wrappedTokens.forEach((wrappedToken, i) => {
            // Find index of wrappedToken in asset array. This is used as ref in Relayer.
            const index = assets.findIndex(
                (token) => token.toLowerCase() === wrappedToken.toLowerCase()
            );
            // There may be cases where swap isn't possible for wrappedToken
            if (index === -1) return;

            const key = Relayer.toChainedReference(i);

            outputReferences.push({
                index: index,
                key: key,
            });

            // console.log(`Unwrapping ${wrappedToken} with amt: ${key.toHexString()}`);

            switch (unwrapType) {
                case 'aave':
                    unwrapCalls.push(
                        Relayer.encodeUnwrapAaveStaticToken({
                            staticToken: wrappedToken,
                            sender: funds.recipient, // This should be relayer
                            recipient: funds.sender, // This will be caller
                            amount: key, // Use output of swap as input for unwrap
                            toUnderlying: true,
                            outputReferences: 0,
                        })
                    );
                    break;
                case 'yearn':
                    unwrapCalls.push(
                        Relayer.encodeUnwrapYearnVaultToken({
                            vaultToken: wrappedToken,
                            sender: funds.recipient, // This should be relayer
                            recipient: funds.sender, // This will be caller
                            amount: key, // Use output of swap as input for unwrap
                            outputReference: 0,
                        })
                    );
                    break;
            }
        });

        const encodedBatchSwap = Relayer.encodeBatchSwap({
            swapType: swapType,
            swaps: swaps,
            assets: assets,
            funds: funds, // Note - this should have Relayer as recipient
            limits: limits.map((l) => l.toString()),
            deadline: MaxUint256,
            value: '0',
            outputReferences: outputReferences,
        });

        return [encodedBatchSwap, ...unwrapCalls];
    }
}
