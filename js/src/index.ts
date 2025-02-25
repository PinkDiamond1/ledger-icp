/** ******************************************************************************
 *  (c) 2019-2020 Zondax GmbH
 *  (c) 2016-2017 Ledger
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ******************************************************************************* */
import Transport from '@ledgerhq/hw-transport';
import {
  ResponseAddress,
  ResponseAppInfo,
  ResponseDeviceInfo,
  ResponseSign,
  ResponseSignUpdateCall,
  ResponseVersion
} from './types';
import {
  ADDRLEN,
  CHUNK_SIZE,
  CLA,
  errorCodeToString,
  getVersion,
  INS,
  LedgerError,
  P1_VALUES,
  PAYLOAD_TYPE,
  PKLEN,
  PREHASH_LEN,
  PRINCIPAL_LEN,
  processErrorResponse,
  serializePath,
  SIGRSLEN,
} from './common';

export {LedgerError};
export * from './types';

function processGetAddrResponse(response: Buffer) {
  let partialResponse = response;

  const errorCodeData = partialResponse.slice(-2);
  const returnCode = (errorCodeData[0] * 256 + errorCodeData[1]);

  const publicKey = Buffer.from(partialResponse.slice(0, PKLEN));
  partialResponse = partialResponse.slice(PKLEN);

  const principal = Buffer.from(partialResponse.slice(0, PRINCIPAL_LEN));

  partialResponse = partialResponse.slice(PRINCIPAL_LEN);

  const address = Buffer.from(partialResponse.slice(0, ADDRLEN));

  partialResponse = partialResponse.slice(ADDRLEN);

  const principalText = Buffer.from(partialResponse.slice(0, -2)).toString().replace(/(.{5})/g, "$1-");

  return {
    publicKey,
    principal,
    address,
    principalText,
    returnCode,
    errorMessage: errorCodeToString(returnCode),
  };
}

export default class InternetComputerApp {
  private transport: Transport;

  constructor(transport: Transport) {
    if (!transport) {
      throw new Error('Transport has not been defined');
    }
    this.transport = transport
  }

  static prepareChunks(serializedPathBuffer: Buffer, message: Buffer) {
    const chunks = [];

    // First chunk (only path)
    chunks.push(serializedPathBuffer);

    const messageBuffer = Buffer.from(message);

    const buffer = Buffer.concat([messageBuffer]);
    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      let end = i + CHUNK_SIZE;
      if (i > buffer.length) {
        end = buffer.length;
      }
      chunks.push(buffer.slice(i, end));
    }

    return chunks;
  }

  async signGetChunks(path: string, message: Buffer) {
    return InternetComputerApp.prepareChunks(serializePath(path), message);
  }

  async getVersion(): Promise<ResponseVersion> {
    return getVersion(this.transport).catch(err => processErrorResponse(err));
  }

  async getAppInfo(): Promise<ResponseAppInfo> {
    return this.transport.send(0xb0, 0x01, 0, 0).then(response => {
      const errorCodeData = response.slice(-2);
      const returnCode = errorCodeData[0] * 256 + errorCodeData[1];

      const result: { errorMessage?: string; returnCode?: LedgerError } = {};

      let appName = 'err';
      let appVersion = 'err';
      let flagLen = 0;
      let flagsValue = 0;

      if (response[0] !== 1) {
        // Ledger responds with format ID 1. There is no spec for any format != 1
        result.errorMessage = 'response format ID not recognized';
        result.returnCode = LedgerError.DeviceIsBusy;
      } else {
        const appNameLen = response[1];
        appName = response.slice(2, 2 + appNameLen).toString('ascii');
        let idx = 2 + appNameLen;
        const appVersionLen = response[idx];
        idx += 1;
        appVersion = response.slice(idx, idx + appVersionLen).toString('ascii');
        idx += appVersionLen;
        const appFlagsLen = response[idx];
        idx += 1;
        flagLen = appFlagsLen;
        flagsValue = response[idx];
      }

      return {
        returnCode,
        errorMessage: errorCodeToString(returnCode),
        //
        appName,
        appVersion,
        flagLen,
        flagsValue,
        flagRecovery: (flagsValue & 1) !== 0,
        // eslint-disable-next-line no-bitwise
        flagSignedMcuCode: (flagsValue & 2) !== 0,
        // eslint-disable-next-line no-bitwise
        flagOnboarded: (flagsValue & 4) !== 0,
        // eslint-disable-next-line no-bitwise
        flagPINValidated: (flagsValue & 128) !== 0,
      };
    }, processErrorResponse);
  }

  async deviceInfo(): Promise<ResponseDeviceInfo> {
    return this.transport.send(0xe0, 0x01, 0, 0, Buffer.from([]), [0x6e00])
      .then(response => {
        const errorCodeData = response.slice(-2);
        const returnCode = errorCodeData[0] * 256 + errorCodeData[1];

        if (returnCode === 0x6e00) {
          return {
            return_code: returnCode,
            error_message: "This command is only available in the Dashboard",
          };
        }

        const targetId = response.slice(0, 4).toString("hex");

        let pos = 4;
        const secureElementVersionLen = response[pos];
        pos += 1;
        const seVersion = response.slice(pos, pos + secureElementVersionLen).toString();
        pos += secureElementVersionLen;

        const flagsLen = response[pos];
        pos += 1;
        const flag = response.slice(pos, pos + flagsLen).toString("hex");
        pos += flagsLen;

        const mcuVersionLen = response[pos];
        pos += 1;
        // Patch issue in mcu version
        let tmp = response.slice(pos, pos + mcuVersionLen);
        if (tmp[mcuVersionLen - 1] === 0) {
          tmp = response.slice(pos, pos + mcuVersionLen - 1);
        }
        const mcuVersion = tmp.toString();

        return {
          returnCode: returnCode,
          errorMessage: errorCodeToString(returnCode),
          // //
          targetId,
          seVersion,
          flag,
          mcuVersion,
        };
      }, processErrorResponse);
  }

  async getAddressAndPubKey(path: string): Promise<ResponseAddress> {
    const serializedPath = serializePath(path);
    return this.transport
      .send(CLA, INS.GET_ADDR_SECP256K1, P1_VALUES.ONLY_RETRIEVE, 0, serializedPath, [0x9000])
      .then(processGetAddrResponse, processErrorResponse);
  }

  async showAddressAndPubKey(path: string): Promise<ResponseAddress> {
    const serializedPath = serializePath(path);

    return this.transport
      .send(CLA, INS.GET_ADDR_SECP256K1, P1_VALUES.SHOW_ADDRESS_IN_DEVICE, 0, serializedPath, [
        LedgerError.NoErrors,
      ])
      .then(processGetAddrResponse, processErrorResponse);
  }

  async signSendChunk(chunkIdx: number, chunkNum: number, chunk: Buffer, txtype: number): Promise<ResponseSign> {
    let payloadType = PAYLOAD_TYPE.ADD;
    if (chunkIdx === 1) {
      payloadType = PAYLOAD_TYPE.INIT;
    }
    if (chunkIdx === chunkNum) {
      payloadType = PAYLOAD_TYPE.LAST;
    }

    return this.transport
      .send(CLA, INS.SIGN_SECP256K1, payloadType, txtype, chunk, [
        LedgerError.NoErrors,
        LedgerError.DataIsInvalid,
        LedgerError.BadKeyHandle,
        LedgerError.SignVerifyError
      ])
      .then((response: Buffer) => {
        const errorCodeData = response.slice(-2);
        const returnCode = errorCodeData[0] * 256 + errorCodeData[1];
        let errorMessage = errorCodeToString(returnCode);

        let preSignHash = Buffer.alloc(0);
        let signatureRS = Buffer.alloc(0);
        let signatureDER = Buffer.alloc(0);

        if (returnCode === LedgerError.BadKeyHandle ||
          returnCode === LedgerError.DataIsInvalid ||
          returnCode === LedgerError.SignVerifyError) {
          errorMessage = `${errorMessage} : ${response
            .slice(0, response.length - 2)
            .toString('ascii')}`;
        }

        if (returnCode === LedgerError.NoErrors && response.length > 2) {
          preSignHash = response.slice(0, PREHASH_LEN);
          signatureRS = response.slice(PREHASH_LEN, PREHASH_LEN + SIGRSLEN);
          signatureDER = response.slice(PREHASH_LEN + SIGRSLEN + 1, response.length - 2);
          return {
            preSignHash,
            signatureRS,
            signatureDER,
            returnCode: returnCode,
            errorMessage: errorMessage,
          };
        }

        return {
          returnCode: returnCode,
          errorMessage: errorMessage,
        } as ResponseSign;

      }, processErrorResponse);
  }

  async sign(path: string, message: Buffer, txtype: number) {
    return this.signGetChunks(path, message).then(chunks => {
      return this.signSendChunk(1, chunks.length, chunks[0], txtype % 256).then(async response => {
        let result = {
          returnCode: response.returnCode,
          errorMessage: response.errorMessage,
          preSignHash: null as null | Buffer,
          signatureRS: null as null | Buffer,
          signatureDER: null as null | Buffer,
        } as ResponseSign;

        for (let i = 1; i < chunks.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          result = await this.signSendChunk(1 + i, chunks.length, chunks[i], txtype % 256);
          if (result.returnCode !== LedgerError.NoErrors) {
            break;
          }
        }
        return result;
      }, processErrorResponse);
    }, processErrorResponse);
  }

  async signSendChunkUpdateCall(chunkIdx: number, chunkNum: number, chunk: Buffer, txtype: number): Promise<ResponseSignUpdateCall> {
    let payloadType = PAYLOAD_TYPE.ADD;
    if (chunkIdx === 1) {
      payloadType = PAYLOAD_TYPE.INIT;
    }
    if (chunkIdx === chunkNum) {
      payloadType = PAYLOAD_TYPE.LAST;
    }

    return this.transport
        .send(CLA, INS.SIGN_COMBINED, payloadType, txtype, chunk, [
          LedgerError.NoErrors,
          LedgerError.DataIsInvalid,
          LedgerError.BadKeyHandle,
          LedgerError.SignVerifyError
        ])
        .then((response: Buffer) => {
          const errorCodeData = response.slice(-2);
          const returnCode = errorCodeData[0] * 256 + errorCodeData[1];
          let errorMessage = errorCodeToString(returnCode);

          let RequestHash = Buffer.alloc(0);
          let RequestSignatureRS = Buffer.alloc(0);
          let StatusReadHash = Buffer.alloc(0);
          let StatusReadSignatureRS = Buffer.alloc(0);

          if (returnCode === LedgerError.BadKeyHandle ||
              returnCode === LedgerError.DataIsInvalid ||
              returnCode === LedgerError.SignVerifyError) {
            errorMessage = `${errorMessage} : ${response
                .slice(0, response.length - 2)
                .toString('ascii')}`;
          }

          if (returnCode === LedgerError.NoErrors && response.length > 2) {
            RequestHash = response.slice(0, 32);
            RequestSignatureRS = response.slice(32, 96);
            StatusReadHash = response.slice(96, 128);
            StatusReadSignatureRS = response.slice(128, 192);
            return {
              RequestHash,
              RequestSignatureRS,
              StatusReadHash,
              StatusReadSignatureRS,
              returnCode: returnCode,
              errorMessage: errorMessage,
            };
          }

          return {
            returnCode: returnCode,
            errorMessage: errorMessage,
          } as ResponseSignUpdateCall;

        }, processErrorResponse);
  }

  async signUpdateCall(path: string, request: Buffer, checkStatus: Buffer, txtype: number) {
    const message = Buffer.alloc(8 + request.byteLength + checkStatus.byteLength);
    message.writeUInt32LE(checkStatus.byteLength, 0);
    checkStatus.copy(message, 4);
    message.writeUInt32LE(request.byteLength, 4 + checkStatus.byteLength);
    request.copy(message, 8 + checkStatus.byteLength);
    console.log(message.toString('hex'))
    return this.signGetChunks(path, message).then(chunks => {
      return this.signSendChunk(1, chunks.length, chunks[0], txtype % 256).then(async response => {
        let result = {
          returnCode: response.returnCode,
          errorMessage: response.errorMessage,
          RequestHash: null as null | Buffer,
          RequestSignatureRS: null as null | Buffer,
          StatusReadHash: null as null | Buffer,
          StatusReadSignatureRS: null as null | Buffer,
        } as ResponseSignUpdateCall;

        for (let i = 1; i < chunks.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          result = await this.signSendChunkUpdateCall(1 + i, chunks.length, chunks[i], txtype % 256);
          if (result.returnCode !== LedgerError.NoErrors) {
            break;
          }
        }
        return result;
      }, processErrorResponse);
    }, processErrorResponse);
  }
}
