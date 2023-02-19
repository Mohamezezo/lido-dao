const { assert } = require('../../helpers/assert')
const { e9, e18, e27 } = require('../../helpers/utils')

const {
  CONSENSUS_VERSION,
  deployAndConfigureAccountingOracle,
  getReportDataItems,
  encodeExtraDataItems,
  packExtraDataList,
  calcExtraDataListHash,
  calcReportDataHash,
  EXTRA_DATA_FORMAT_LIST,
  SLOTS_PER_FRAME,
  SECONDS_PER_SLOT,
  GENESIS_TIME,
  ZERO_HASH
} = require('./accounting-oracle-deploy.test')

contract('AccountingOracle', ([admin, account1, account2, member1, member2, stranger]) => {
  let consensus = null
  let oracle = null
  let reportItems = null
  let reportFields = null
  let extraDataList = null
  let extraDataHash = null
  let extraDataItems = null
  let oracleVersion = null
  let deadline = null
  let mockStakingRouter = null
  let extraData = null
  let mockLido = null
  let oracleReportSanityChecker = null
  let mockLegacyOracle = null
  let mockWithdrawalQueue = null

  const deploy = async (options = undefined) => {
    const deployed = await deployAndConfigureAccountingOracle(admin)
    const { refSlot } = await deployed.consensus.getCurrentFrame()

    extraData = {
      stuckKeys: [
        { moduleId: 1, nodeOpIds: [0], keysCounts: [1] },
        { moduleId: 2, nodeOpIds: [0], keysCounts: [2] },
        { moduleId: 3, nodeOpIds: [2], keysCounts: [3] }
      ],
      exitedKeys: [
        { moduleId: 2, nodeOpIds: [1, 2], keysCounts: [1, 3] },
        { moduleId: 3, nodeOpIds: [1], keysCounts: [2] }
      ]
    }

    extraDataItems = encodeExtraDataItems(extraData)
    extraDataList = packExtraDataList(extraDataItems)
    extraDataHash = calcExtraDataListHash(extraDataList)
    reportFields = {
      consensusVersion: CONSENSUS_VERSION,
      refSlot: +refSlot,
      numValidators: 10,
      clBalanceGwei: e9(320),
      stakingModuleIdsWithNewlyExitedValidators: [1],
      numExitedValidatorsByStakingModule: [3],
      withdrawalVaultBalance: e18(1),
      elRewardsVaultBalance: e18(2),
      lastWithdrawalRequestIdToFinalize: 1,
      finalizationShareRate: e27(1),
      isBunkerMode: true,
      extraDataFormat: EXTRA_DATA_FORMAT_LIST,
      extraDataHash: extraDataHash,
      extraDataItemsCount: extraDataItems.length
    }
    reportItems = getReportDataItems(reportFields)
    const reportHash = calcReportDataHash(reportItems)
    await deployed.consensus.addMember(member1, 1, { from: admin })
    await deployed.consensus.submitReport(refSlot, reportHash, CONSENSUS_VERSION, { from: member1 })

    oracleVersion = +(await deployed.oracle.getContractVersion())
    deadline = (await deployed.oracle.getConsensusReport()).processingDeadlineTime

    oracle = deployed.oracle
    consensus = deployed.consensus
    mockStakingRouter = deployed.stakingRouter
    mockLido = deployed.lido
    oracleReportSanityChecker = deployed.oracleReportSanityChecker
    mockLegacyOracle = deployed.legacyOracle
    mockWithdrawalQueue = deployed.withdrawalQueue
  }

  async function prepareNextReport(newReportFields) {
    await consensus.setTime(deadline)

    const newReportItems = getReportDataItems(newReportFields)
    const reportHash = calcReportDataHash(newReportItems)

    await consensus.advanceTimeToNextFrameStart()
    await consensus.submitReport(newReportFields.refSlot, reportHash, CONSENSUS_VERSION, { from: member1 })

    return {
      newReportFields,
      newReportItems,
      reportHash
    }
  }

  async function prepareNextReportInNextFrame(newReportFields) {
    const { refSlot } = await consensus.getCurrentFrame()
    const next = await prepareNextReport({
      ...newReportFields,
      refSlot: +refSlot + SLOTS_PER_FRAME
    })
    return next
  }

  context('deploying', () => {
    before(deploy)

    it('deploying accounting oracle', async () => {
      assert.isNotNull(oracle)
      assert.isNotNull(consensus)
      assert.isNotNull(reportItems)
      assert.isNotNull(extraData)
      assert.isNotNull(extraDataList)
      assert.isNotNull(extraDataHash)
      assert.isNotNull(extraDataItems)
      assert.isNotNull(oracleVersion)
      assert.isNotNull(deadline)
      assert.isNotNull(mockStakingRouter)
      assert.isNotNull(mockLido)
    })
  })

  context('submitReportData', () => {
    beforeEach(deploy)

    context('checks contract version', () => {
      it('should revert if incorrect contract version', async () => {
        await consensus.setTime(deadline)

        const incorrectNextVersion = oracleVersion + 1
        const incorrectPrevVersion = oracleVersion - 1

        await assert.reverts(
          oracle.submitReportData(reportItems, incorrectNextVersion, { from: member1 }),
          `UnexpectedContractVersion(${oracleVersion}, ${incorrectNextVersion})`
        )

        await assert.reverts(
          oracle.submitReportData(reportItems, incorrectPrevVersion, { from: member1 }),
          `UnexpectedContractVersion(${oracleVersion}, ${incorrectPrevVersion})`
        )
      })

      it('should should allow calling if correct contract version', async () => {
        await consensus.setTime(deadline)

        const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })
      })
    })

    context('checks ref slot', () => {
      it('should revert if incorrect ref slot', async () => {
        await consensus.setTime(deadline)
        const { refSlot } = await consensus.getCurrentFrame()

        const incorrectRefSlot = +refSlot + 1

        const newReportFields = {
          ...reportFields,
          refSlot: incorrectRefSlot
        }
        const reportItems = getReportDataItems(newReportFields)

        await assert.reverts(
          oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
          `UnexpectedRefSlot(${refSlot}, ${incorrectRefSlot})`
        )
      })

      it('should should allow calling if correct ref slot', async () => {
        await consensus.setTime(deadline)
        const { newReportFields, newReportItems } = await prepareNextReportInNextFrame({ ...reportFields })
        const tx = await oracle.submitReportData(newReportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: newReportFields.refSlot })
      })
    })

    context('checks consensus version', () => {
      it('should revert if incorrect consensus version', async () => {
        await consensus.setTime(deadline)

        const incorrectNextVersion = CONSENSUS_VERSION + 1
        const incorrectPrevVersion = CONSENSUS_VERSION + 1

        const newReportFields = {
          ...reportFields,
          consensusVersion: incorrectNextVersion
        }
        const reportItems = getReportDataItems(newReportFields)

        const reportFieldsPrevVersion = { ...reportFields, consensusVersion: incorrectPrevVersion }
        const reportItemsPrevVersion = getReportDataItems(reportFieldsPrevVersion)

        await assert.reverts(
          oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
          `UnexpectedConsensusVersion(${oracleVersion}, ${incorrectNextVersion})`
        )

        await assert.reverts(
          oracle.submitReportData(reportItemsPrevVersion, oracleVersion, { from: member1 }),
          `UnexpectedConsensusVersion(${oracleVersion}, ${incorrectPrevVersion})`
        )
      })

      it('should should allow calling if correct consensus version', async () => {
        await consensus.setTime(deadline)
        const { refSlot } = await consensus.getCurrentFrame()

        const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })

        const newConsensusVersion = CONSENSUS_VERSION + 1
        const nextRefSlot = +refSlot + SLOTS_PER_FRAME
        const newReportFields = {
          ...reportFields,
          refSlot: nextRefSlot,
          consensusVersion: newConsensusVersion
        }
        const newReportItems = getReportDataItems(newReportFields)
        const newReportHash = calcReportDataHash(newReportItems)

        await oracle.setConsensusVersion(newConsensusVersion, { from: admin })
        await consensus.advanceTimeToNextFrameStart()
        await consensus.submitReport(newReportFields.refSlot, newReportHash, newConsensusVersion, { from: member1 })

        const txNewVersion = await oracle.submitReportData(newReportItems, oracleVersion, { from: member1 })
        assert.emits(txNewVersion, 'ProcessingStarted', { refSlot: newReportFields.refSlot })
      })
    })

    context('enforces module ids sorting order', () => {
      beforeEach(deploy)

      it('should revert if incorrect stakingModuleIdsWithNewlyExitedValidators order (when next number in list is less than previous)', async () => {
        const { newReportItems } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [2, 1],
          numExitedValidatorsByStakingModule: [3, 4]
        })

        await assert.reverts(
          oracle.submitReportData(newReportItems, oracleVersion, { from: member1 }),
          'InvalidExitedValidatorsData()'
        )
      })

      it('should revert if incorrect stakingModuleIdsWithNewlyExitedValidators order (when next number in list equals to previous)', async () => {
        const { newReportItems } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 1],
          numExitedValidatorsByStakingModule: [3, 4]
        })

        await assert.reverts(
          oracle.submitReportData(newReportItems, oracleVersion, { from: member1 }),
          'InvalidExitedValidatorsData()'
        )
      })

      it('should should allow calling if correct extra data list moduleId', async () => {
        const { newReportFields, newReportItems } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 2],
          numExitedValidatorsByStakingModule: [3, 4]
        })

        const tx = await oracle.submitReportData(newReportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: newReportFields.refSlot })
      })
    })

    context('checks data hash', () => {
      it('reverts with UnexpectedDataHash', async () => {
        const incorrectReportItems = getReportDataItems({
          ...reportFields,
          numValidators: reportFields.numValidators - 1
        })

        const correctDataHash = calcReportDataHash(reportItems)
        const incorrectDataHash = calcReportDataHash(incorrectReportItems)

        await assert.reverts(
          oracle.submitReportData(incorrectReportItems, oracleVersion, { from: member1 }),
          `UnexpectedDataHash("${correctDataHash}", "${incorrectDataHash}")`
        )
      })

      it('submits if data successfully pass hash validation', async () => {
        const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })
      })
    })

    context('enforces data safety boundaries', () => {
      it('reverts with MaxAccountingExtraDataItemsCountExceeded if data limit exceeds', async () => {
        const MAX_ACCOUNTING_EXTRA_DATA_LIMIT = 1
        await oracleReportSanityChecker.setMaxAccountingExtraDataListItemsCount(MAX_ACCOUNTING_EXTRA_DATA_LIMIT, {
          from: admin
        })

        assert.equals(
          (await oracleReportSanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount,
          MAX_ACCOUNTING_EXTRA_DATA_LIMIT
        )

        await assert.reverts(
          oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
          `MaxAccountingExtraDataItemsCountExceeded(${MAX_ACCOUNTING_EXTRA_DATA_LIMIT}, ${reportFields.extraDataItemsCount})`
        )
      })

      it('passes fine on borderline data limit value — when it equals to count of passed items', async () => {
        const MAX_ACCOUNTING_EXTRA_DATA_LIMIT = reportFields.extraDataItemsCount

        await oracleReportSanityChecker.setMaxAccountingExtraDataListItemsCount(MAX_ACCOUNTING_EXTRA_DATA_LIMIT, {
          from: admin
        })

        assert.equals(
          (await oracleReportSanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount,
          MAX_ACCOUNTING_EXTRA_DATA_LIMIT
        )

        await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
      })

      it('reverts with InvalidExitedValidatorsData if counts of stakingModuleIds and numExitedValidatorsByStakingModule does not match', async () => {
        const { newReportItems } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 2],
          numExitedValidatorsByStakingModule: [3]
        })
        await assert.reverts(
          oracle.submitReportData(newReportItems, oracleVersion, { from: member1 }),
          'InvalidExitedValidatorsData()'
        )
      })

      it('reverts with InvalidExitedValidatorsData if any record for number of exited validators equals 0', async () => {
        const { newReportItems } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [1, 2],
          numExitedValidatorsByStakingModule: [3, 0]
        })
        await assert.reverts(
          oracle.submitReportData(newReportItems, oracleVersion, { from: member1 }),
          'InvalidExitedValidatorsData()'
        )
      })

      it('reverts with NumExitedValidatorsCannotDecrease if total count of exited validators less then previous exited number', async () => {
        const totalExitedValidators = reportFields.numExitedValidatorsByStakingModule.reduce(
          (sum, curr) => sum + curr,
          0
        )
        await mockStakingRouter.setExitedKeysCountAcrossAllModules(totalExitedValidators + 1)
        await assert.reverts(
          oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
          'NumExitedValidatorsCannotDecrease()'
        )
      })

      it('does not reverts with NumExitedValidatorsCannotDecrease if total count of exited validators equals to previous exited number', async () => {
        const totalExitedValidators = reportFields.numExitedValidatorsByStakingModule.reduce(
          (sum, curr) => sum + curr,
          0
        )
        await mockStakingRouter.setExitedKeysCountAcrossAllModules(totalExitedValidators)
        await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
      })

      it('reverts with ExitedValidatorsLimitExceeded if exited validators rate limit will be reached', async () => {
        // Really simple test here for now
        // TODO: Come up with more tests for better coverage of edge-case scenarios that can be accrued
        //       during calculation `exitedValidatorsPerDay` rate in AccountingOracle:612
        const totalExitedValidators = reportFields.numExitedValidatorsByStakingModule.reduce(
          (sum, curr) => sum + curr,
          0
        )
        const exitingRateLimit = totalExitedValidators - 1
        await oracleReportSanityChecker.setChurnValidatorsPerDayLimit(exitingRateLimit)
        assert.equals(
          (await oracleReportSanityChecker.getOracleReportLimits()).churnValidatorsPerDayLimit,
          exitingRateLimit
        )
        await assert.reverts(
          oracle.submitReportData(reportItems, oracleVersion, { from: member1 }),
          `ExitedValidatorsLimitExceeded(${exitingRateLimit}, ${totalExitedValidators})`
        )
      })
    })

    context('delivers the data to corresponded contracts', () => {
      it('should call handleOracleReport on Lido', async () => {
        assert.equals((await mockLido.getLastCall_handleOracleReport()).callCount, 0)
        await consensus.setTime(deadline)
        const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })

        const lastOracleReportToLido = await mockLido.getLastCall_handleOracleReport()

        assert.equals(lastOracleReportToLido.callCount, 1)
        assert.equals(
          lastOracleReportToLido.currentReportTimestamp,
          GENESIS_TIME + reportFields.refSlot * SECONDS_PER_SLOT
        )

        assert.equals(lastOracleReportToLido.clBalance, reportFields.clBalanceGwei + '000000000')
        assert.equals(lastOracleReportToLido.withdrawalVaultBalance, reportFields.withdrawalVaultBalance)
        assert.equals(lastOracleReportToLido.elRewardsVaultBalance, reportFields.elRewardsVaultBalance)
        assert.equals(
          lastOracleReportToLido.lastWithdrawalRequestIdToFinalize,
          reportFields.lastWithdrawalRequestIdToFinalize
        )
        assert.equals(lastOracleReportToLido.finalizationShareRate, reportFields.finalizationShareRate)
      })

      it('should call updateExitedValidatorsCountByStakingModule on StakingRouter', async () => {
        assert.equals((await mockStakingRouter.lastCall_updateExitedKeysByModule()).callCount, 0)
        await consensus.setTime(deadline)
        const tx = await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: reportFields.refSlot })

        const lastOracleReportToStakingRouter = await mockStakingRouter.lastCall_updateExitedKeysByModule()

        assert.equals(lastOracleReportToStakingRouter.callCount, 1)
        assert.equals(lastOracleReportToStakingRouter.moduleIds, reportFields.stakingModuleIdsWithNewlyExitedValidators)
        assert.equals(lastOracleReportToStakingRouter.exitedKeysCounts, reportFields.numExitedValidatorsByStakingModule)
      })

      it('does not calling StakingRouter.updateExitedKeysByModule if lists of exited validators is empty', async () => {
        const { newReportItems, newReportFields } = await prepareNextReportInNextFrame({
          ...reportFields,
          stakingModuleIdsWithNewlyExitedValidators: [],
          numExitedValidatorsByStakingModule: []
        })
        const tx = await oracle.submitReportData(newReportItems, oracleVersion, { from: member1 })
        assert.emits(tx, 'ProcessingStarted', { refSlot: newReportFields.refSlot })
        const lastOracleReportToStakingRouter = await mockStakingRouter.lastCall_updateExitedKeysByModule()
        assert.equals(lastOracleReportToStakingRouter.callCount, 0)
      })

      it('should call handleConsensusLayerReport on legacyOracle', async () => {
        await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        const lastCall = await mockLegacyOracle.lastCall__handleConsensusLayerReport()
        assert.equal(+lastCall.totalCalls, 1)
        assert.equal(+lastCall.refSlot, reportFields.refSlot)
        assert.equal(+lastCall.clBalance, e9(reportFields.clBalanceGwei))
        assert.equal(+lastCall.clValidators, reportFields.numValidators)
      })

      it('should call updateBunkerMode on WithdrawalQueue', async () => {
        const prevProcessingRefSlot = +(await oracle.getLastProcessingRefSlot())
        await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        const lastCall = await mockWithdrawalQueue.lastCall__updateBunkerMode()
        assert.equal(+lastCall.callCount, 1)
        assert.equal(+lastCall.isBunkerMode, reportFields.isBunkerMode)
        assert.equal(+lastCall.prevReportTimestamp, GENESIS_TIME + prevProcessingRefSlot * SECONDS_PER_SLOT)
      })
    })

    context('enforces extra data format', () => {
      it('should revert on invalid extra data format', async () => {
        await consensus.setTime(deadline)
        await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })

        const nextRefSlot = reportFields.refSlot + SLOTS_PER_FRAME
        const changedReportItems = getReportDataItems({
          ...reportFields,
          refSlot: nextRefSlot,
          extraDataFormat: EXTRA_DATA_FORMAT_LIST + 1
        })

        const changedReportHash = calcReportDataHash(changedReportItems)
        await consensus.advanceTimeToNextFrameStart()
        await consensus.submitReport(nextRefSlot, changedReportHash, CONSENSUS_VERSION, {
          from: member1
        })

        await assert.revertsWithCustomError(
          oracle.submitReportData(changedReportItems, oracleVersion, { from: member1 }),
          `UnsupportedExtraDataFormat(${EXTRA_DATA_FORMAT_LIST + 1})`
        )
      })
    })

    context('ExtraDataProcessingState', () => {
      it('should be empty from start', async () => {
        const data = await oracle.getExtraDataProcessingState()
        assert.equals(data.refSlot, '0')
        assert.equals(data.dataFormat, '0')
        assert.equals(data.itemsCount, '0')
        assert.equals(data.itemsProcessed, '0')
        assert.equals(data.lastSortingKey, '0')
        assert.equals(data.dataHash, ZERO_HASH)
      })

      it('should be filled with report data after submitting', async () => {
        await oracle.submitReportData(reportItems, oracleVersion, { from: member1 })
        const data = await oracle.getExtraDataProcessingState()
        assert.equals(data.refSlot, reportFields.refSlot)
        assert.equals(data.dataFormat, reportFields.extraDataFormat)
        assert.equals(data.itemsCount, reportFields.extraDataItemsCount)
        assert.equals(data.itemsProcessed, '0')
        assert.equals(data.lastSortingKey, '0')
        assert.equals(data.dataHash, reportFields.extraDataHash)
      })
    })
  })
})
