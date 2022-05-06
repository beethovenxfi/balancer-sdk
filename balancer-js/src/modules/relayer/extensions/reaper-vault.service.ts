import {
    EncodeReaperUnwrapInput,
    EncodeReaperWrapInput,
} from '@/modules/relayer/types';
import { Interface } from '@ethersproject/abi';
import reaperWrappingAbi from '@/lib/abi/ReaperWrapping.json';

export class ReaperVaultService {
    public encodeWrap(params: EncodeReaperWrapInput): string {
        const reaperWrappingLibrary = new Interface(reaperWrappingAbi);

        return reaperWrappingLibrary.encodeFunctionData(
            'wrapReaperVaultToken',
            [
                params.vaultToken,
                params.sender,
                params.recipient,
                params.amount,
                params.outputReference,
            ]
        );
    }

    public encodeUnwrap(params: EncodeReaperUnwrapInput): string {
        const reaperWrappingLibrary = new Interface(reaperWrappingAbi);

        return reaperWrappingLibrary.encodeFunctionData(
            'unwrapReaperVaultToken',
            [
                params.vaultToken,
                params.sender,
                params.recipient,
                params.amount,
                params.outputReference,
            ]
        );
    }
}
