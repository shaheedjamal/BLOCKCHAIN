'use strict';

/**
 * Hyperledger Fabric Chaincode Reference (fabric-contract-api)
 * Smart Contract: LandRecordContract
 *
 * Enforces permissioned MSP endorsements, approval references, parcel version
 * optimistic concurrency, duplicate transaction prevention, and minimal metadata privacy.
 */

class LandRecordContract {
  async CreateParcel(ctx, parcelId, surveyNo, locality, geometryRef, approvalReference) {
    this._requireAuthorizedMsp(ctx, ['RevenueDeptMSP', 'RegistrarAuthorityMSP']);
    if (!approvalReference) {
      throw new Error('MANDATORY_APPROVAL_REFERENCE_MISSING');
    }

    const existing = await ctx.stub.getState(`PARCEL_${parcelId}`);
    if (existing && existing.length > 0) {
      throw new Error(`PARCEL_ALREADY_EXISTS: ${parcelId}`);
    }

    const txTime = new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString();
    const record = {
      parcelId,
      surveyNo,
      locality,
      geometryRef,
      version: 1,
      status: 'ACTIVE',
      lastTxId: ctx.stub.getTxID(),
      updatedAt: txTime
    };

    await ctx.stub.putState(`PARCEL_${parcelId}`, Buffer.from(JSON.stringify(record)));
    await this._appendEvent(ctx, parcelId, null, 'PARCEL_GENESIS', 1, approvalReference, [], txTime);
    return JSON.stringify(record);
  }

  async RecordApprovedMutation(ctx, parcelId, applicationId, eventType, expectedVersionStr, approvalReference, docHashesJson) {
    this._requireAuthorizedMsp(ctx, ['RegistrarAuthorityMSP', 'RevenueDeptMSP']);

    if (!approvalReference) {
      throw new Error('MANDATORY_APPROVAL_REFERENCE_MISSING');
    }

    const dupCheck = await ctx.stub.getState(`APP_EVENT_${applicationId}`);
    if (dupCheck && dupCheck.length > 0) {
      throw new Error(`DUPLICATE_TRANSACTION: Application ${applicationId} already committed.`);
    }

    const parcelBytes = await ctx.stub.getState(`PARCEL_${parcelId}`);
    if (!parcelBytes || parcelBytes.length === 0) {
      throw new Error(`PARCEL_NOT_FOUND: ${parcelId}`);
    }

    const parcel = JSON.parse(parcelBytes.toString());
    const expectedVersion = parseInt(expectedVersionStr, 10);
    if (parcel.version !== expectedVersion) {
      throw new Error(`STALE_PARCEL_VERSION: Expected ${expectedVersion}, current ${parcel.version}`);
    }

    const nextVersion = parcel.version + 1;
    const txTime = new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString();
    const docHashes = JSON.parse(docHashesJson || '[]');

    parcel.version = nextVersion;
    parcel.lastTxId = ctx.stub.getTxID();
    parcel.updatedAt = txTime;

    await ctx.stub.putState(`PARCEL_${parcelId}`, Buffer.from(JSON.stringify(parcel)));
    await ctx.stub.putState(`APP_EVENT_${applicationId}`, Buffer.from(ctx.stub.getTxID()));

    const evt = await this._appendEvent(ctx, parcelId, applicationId, eventType, nextVersion, approvalReference, docHashes, txTime);
    return JSON.stringify(evt);
  }

  async _appendEvent(ctx, parcelId, applicationId, eventType, parcelVersion, approvalReference, docHashes, timestamp) {
    const event = {
      txId: ctx.stub.getTxID(),
      parcelId,
      applicationId,
      eventType,
      parcelVersion,
      approvalReference,
      docHashes,
      timestamp
    };
    const key = `EVT_${parcelId}_${String(parcelVersion).padStart(6, '0')}`;
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(event)));
    ctx.stub.setEvent('LandRecordEvent', Buffer.from(JSON.stringify(event)));
    return event;
  }

  _requireAuthorizedMsp(ctx, allowedMsps) {
    const mspId = ctx.clientIdentity.getMSPID();
    if (!allowedMsps.includes(mspId)) {
      throw new Error(`UNAUTHORIZED_MSP_IDENTITY: ${mspId} is not permitted.`);
    }
  }
}

module.exports = LandRecordContract;
