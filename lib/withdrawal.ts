import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  NFTDescriptorMock,
  OssifiableProxy,
  StETHPermitMock,
  WithdrawalQueueERC721,
  WstETHMock,
} from "typechain-types";

import { MAX_UINT256, ONE_ETHER, proxify, streccak } from "lib";

export const QUEUE_NAME = "Lido: Withdrawal Request NFT";
export const QUEUE_SYMBOL = "unstETH";

export const WQ_MAX_BATCHES_LENGTH = 36n;

export const WQ_BUNKER_MODE_DISABLED_TIMESTAMP = MAX_UINT256;

export const WQ_MIN_STETH_WITHDRAWAL_AMOUNT = 100n;
export const WQ_MAX_STETH_WITHDRAWAL_AMOUNT = 10n ** 21n; // 1000 * 1e18

export const WQ_FINALIZE_ROLE = streccak("FINALIZE_ROLE");
export const WQ_MANAGE_TOKEN_URI_ROLE = streccak("MANAGE_TOKEN_URI_ROLE");
export const WQ_ORACLE_ROLE = streccak("ORACLE_ROLE");
export const WQ_PAUSE_ROLE = streccak("PAUSE_ROLE");
export const WQ_RESUME_ROLE = streccak("RESUME_ROLE");

export const WQ_PAUSE_INFINITELY = MAX_UINT256;

interface StEthDeploymentParams {
  initialStEth: bigint;
  owner?: HardhatEthersSigner;
  ownerStEth?: bigint;
  ownerStShares?: bigint;
}

interface BaseWithdrawalQueueDeploymentParams {
  stEthSettings?: StEthDeploymentParams;
  name?: string;
  symbol?: string;
}

interface WithdrawalQueueDeploymentParams extends BaseWithdrawalQueueDeploymentParams {
  queueAdmin: HardhatEthersSigner;
  queuePauser?: HardhatEthersSigner;
  queueResumer?: HardhatEthersSigner;
  queueFinalizer?: HardhatEthersSigner;
  queueOracle?: HardhatEthersSigner;

  doInitialise?: boolean;
  doResume?: boolean;
}

export const MOCK_NFT_DESCRIPTOR_BASE_URI = "https://example-descriptor.com/";

async function deployNftDescriptor() {
  const nftDescriptor = await ethers.deployContract("NFTDescriptorMock", [MOCK_NFT_DESCRIPTOR_BASE_URI]);

  return { nftDescriptor, nftDescriptorAddress: await nftDescriptor.getAddress() };
}

async function deployStEthMock(stEthSettings: StEthDeploymentParams) {
  const stEth = await ethers.deployContract("StETHPermitMock", {
    value: stEthSettings.initialStEth,
  });

  if (stEthSettings.owner) {
    await stEth.initializeEIP712StETH(stEthSettings.owner);

    if (stEthSettings.ownerStEth) {
      await stEth.mintSteth(stEthSettings.owner, { value: stEthSettings.ownerStEth });
    }

    if (stEthSettings.ownerStShares) {
      await stEth.mintShares(stEthSettings.owner, stEthSettings.ownerStShares);
    }
  }

  return { stEth, stEthAddress: await stEth.getAddress() };
}

async function deployWstEthMock(stEthAddress: string) {
  const wstEth = await ethers.deployContract("WstETHMock", [stEthAddress]);
  return { wstEth, wstEthAddress: await wstEth.getAddress() };
}

async function deployWithdrawalQueueImpl({
  stEthSettings = { initialStEth: ONE_ETHER },
  name = QUEUE_NAME,
  symbol = QUEUE_SYMBOL,
}: BaseWithdrawalQueueDeploymentParams = {}) {
  const { nftDescriptor, nftDescriptorAddress } = await deployNftDescriptor();
  const { stEth, stEthAddress } = await deployStEthMock(stEthSettings);
  const { wstEth, wstEthAddress } = await deployWstEthMock(stEthAddress);

  const deployConfig = [wstEthAddress, name, symbol];

  const impl = await ethers.deployContract("WithdrawalQueueERC721", deployConfig);

  return {
    // Deployed contract
    impl,
    name,
    symbol,
    // Related contracts
    stEth,
    stEthAddress,
    wstEth,
    wstEthAddress,
    nftDescriptor,
    nftDescriptorAddress,
  };
}

export async function deployWithdrawalQueue({
  stEthSettings = { initialStEth: ONE_ETHER },
  name = QUEUE_NAME,
  symbol = QUEUE_SYMBOL,
  queueAdmin,
  queuePauser,
  queueResumer,
  queueFinalizer,
  queueOracle,
  doInitialise = true,
  doResume = true,
}: WithdrawalQueueDeploymentParams): Promise<{
  queue: WithdrawalQueueERC721;
  queueAddress: string;
  impl: WithdrawalQueueERC721;
  name: string;
  symbol: string;
  initTx: ContractTransactionResponse | null;
  stEth: StETHPermitMock;
  stEthAddress: string;
  wstEth: WstETHMock;
  wstEthAddress: string;
  nftDescriptor: NFTDescriptorMock;
  nftDescriptorAddress: string;
  proxy: OssifiableProxy;
}> {
  const { impl, stEth, stEthAddress, wstEth, wstEthAddress, nftDescriptor, nftDescriptorAddress } =
    await deployWithdrawalQueueImpl({ stEthSettings, name, symbol });

  const [queue, proxy] = await proxify({ impl, admin: queueAdmin });

  let initTx = null;
  if (doInitialise) {
    initTx = await queue.initialize(queueAdmin);

    await queue.connect(queueAdmin).grantRole(WQ_FINALIZE_ROLE, queueFinalizer || stEthAddress);
    await queue.connect(queueAdmin).grantRole(WQ_PAUSE_ROLE, queuePauser || queueAdmin);
    await queue.connect(queueAdmin).grantRole(WQ_RESUME_ROLE, queueResumer || queueAdmin);
    await queue.connect(queueAdmin).grantRole(WQ_ORACLE_ROLE, queueOracle || stEthAddress);
    await queue.connect(queueAdmin).grantRole(WQ_MANAGE_TOKEN_URI_ROLE, queueAdmin);

    if (doResume) {
      await queue.connect(queueResumer || queueAdmin).resume();
    }
  }

  return {
    // Deployed contract
    queue,
    queueAddress: await queue.getAddress(),
    impl,
    name,
    symbol,
    initTx,
    // Related contracts
    stEth,
    stEthAddress,
    wstEth,
    wstEthAddress,
    nftDescriptor,
    nftDescriptorAddress,
    proxy,
  };
}
