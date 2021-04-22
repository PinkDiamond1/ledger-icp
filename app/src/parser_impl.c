/*******************************************************************************
*  (c) 2019 Zondax GmbH
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
********************************************************************************/

#include <zxmacros.h>
#include "parser_impl.h"
#include "parser_txdef.h"
#include "cbor.h"
#include "app_mode.h"
#include "pb_decode.h"
#include "protobuf/dfinity.pb.h"

parser_tx_t parser_tx_obj;

__Z_INLINE parser_error_t parser_mapCborError(CborError err);

#define CHECK_CBOR_MAP_ERR(CALL) { \
    CborError err = CALL;  \
    if (err!=CborNoError) return parser_mapCborError(err);}

#define PARSER_ASSERT_OR_ERROR(CALL, ERROR) if (!(CALL)) return ERROR;

#define CHECK_CBOR_TYPE(type, expected) {if (type!=expected) return parser_unexpected_type;}

#define INIT_CBOR_PARSER(c, it)  \
    CborParser parser;           \
    CHECK_CBOR_MAP_ERR(cbor_parser_init(c->buffer + c->offset, c->bufferLen - c->offset, 0, &parser, &it))

parser_error_t parser_init_context(parser_context_t *ctx,
                                   const uint8_t *buffer,
                                   uint16_t bufferSize) {
    ctx->offset = 0;
    ctx->buffer = NULL;
    ctx->bufferLen = 0;

    if (bufferSize == 0 || buffer == NULL) {
        // Not available, use defaults
        return parser_init_context_empty;
    }

    ctx->buffer = buffer;
    ctx->bufferLen = bufferSize;
    return parser_ok;
}

parser_error_t parser_init(parser_context_t *ctx, const uint8_t *buffer, uint16_t bufferSize) {
    CHECK_PARSER_ERR(parser_init_context(ctx, buffer, bufferSize))
    return parser_ok;
}

__Z_INLINE parser_error_t parser_mapCborError(CborError err) {
    switch (err) {
        case CborErrorUnexpectedEOF:
            return parser_cbor_unexpected_EOF;
        case CborErrorMapNotSorted:
            return parser_cbor_not_canonical;
        case CborNoError:
            return parser_ok;
        case CborErrorOutOfMemory: {
            return parser_value_out_of_range;
        }
        default:
            return parser_cbor_unexpected;
    }
}

const char *parser_getErrorDescription(parser_error_t err) {
    switch (err) {
        // General errors
        case parser_ok:
            return "No error";
        case parser_no_data:
            return "No more data";
        case parser_init_context_empty:
            return "Initialized empty context";
        case parser_display_idx_out_of_range:
            return "display_idx_out_of_range";
        case parser_display_page_out_of_range:
            return "display_page_out_of_range";
        case parser_unexepected_error:
            return "Unexepected internal error";
            // cbor
        case parser_cbor_unexpected:
            return "unexpected CBOR error";
        case parser_cbor_not_canonical:
            return "CBOR was not in canonical order";
        case parser_cbor_unexpected_EOF:
            return "Unexpected CBOR EOF";
            // Coin specific
        case parser_unexpected_tx_version:
            return "tx version is not supported";
        case parser_unexpected_type:
            return "Unexpected data type";
        case parser_unexpected_method:
            return "Unexpected method";
        case parser_unexpected_buffer_end:
            return "Unexpected buffer end";
        case parser_unexpected_value:
            return "Unexpected value";
        case parser_unexpected_number_items:
            return "Unexpected number of items";
        case parser_unexpected_characters:
            return "Unexpected characters";
        case parser_unexpected_field:
            return "Unexpected field";
        case parser_value_out_of_range:
            return "Value out of range";
        case parser_invalid_address:
            return "Invalid address format";
            /////////// Context specific
        case parser_context_mismatch:
            return "context prefix is invalid";
        case parser_context_unexpected_size:
            return "context unexpected size";
        case parser_context_invalid_chars:
            return "context invalid chars";
            // Required fields error
        case parser_required_nonce:
            return "Required field nonce";
        case parser_required_method:
            return "Required field method";
        default:
            return "Unrecognized error code";
    }
}

// envelope (TAG 55799)
//    content [map]
//        request_type [text]
//        read_state / query [blob]
//        nonce [blob]
//        ingress_expiry [nat]
//        sender [principal]
//        canister_id [principal]
//        method_name [text]
//        arg [blob]
//    sender_pubkey [blob]
//    sender_sig [blob]

#define READ_INT64(MAP, FIELDNAME, V_OUTPUT) {                                             \
    CborValue it;                                                                          \
    CHECK_CBOR_MAP_ERR(cbor_value_map_find_value(MAP, FIELDNAME, &it));                    \
    (V_OUTPUT) = _cbor_value_decode_int64_internal(&it);                                     \
}

#define READ_STRING(MAP, FIELDNAME, V_OUTPUT) {                                             \
    size_t stringLen = 0;                                                                   \
    CborValue it;                                                                           \
    MEMZERO(&(V_OUTPUT).data, sizeof((V_OUTPUT).data));                                     \
    CHECK_CBOR_MAP_ERR(cbor_value_map_find_value(MAP, FIELDNAME, &it));                     \
    PARSER_ASSERT_OR_ERROR(cbor_value_is_byte_string(&it) || cbor_value_is_text_string(&it), parser_context_mismatch); \
    CHECK_CBOR_MAP_ERR(cbor_value_get_string_length(&it, &stringLen));                      \
    PARSER_ASSERT_OR_ERROR(stringLen < sizeof((V_OUTPUT).data), parser_context_unexpected_size)   \
    (V_OUTPUT).len = stringLen; \
    CHECK_CBOR_MAP_ERR(_cbor_value_copy_string(&it, (V_OUTPUT).data, &(V_OUTPUT).len, NULL)); \
}

parser_error_t parsePaths(CborValue *content_map, parser_tx_t *v){
    CborValue it;                                                                           \
    CHECK_CBOR_MAP_ERR(cbor_value_map_find_value(content_map, "paths", &it));
    PARSER_ASSERT_OR_ERROR(cbor_value_is_container(&it), parser_unexpected_type);

    CborValue content_paths;
    CHECK_CBOR_MAP_ERR(cbor_value_enter_container(&it, &content_paths))

    size_t arrayLen = 0;
    CHECK_CBOR_MAP_ERR(cbor_value_get_array_length(&content_paths,&arrayLen));

    if (arrayLen <= 0 || arrayLen > PATH_MAX_ARRAY){
        return parser_value_out_of_range;
    }
    v->paths.arrayLen = arrayLen;

    CHECK_CBOR_MAP_ERR(cbor_value_enter_container(&content_paths, &it));

    size_t stringLen = 0;

    for(uint8_t index = 0; index < arrayLen; index++){
        PARSER_ASSERT_OR_ERROR(cbor_value_is_byte_string(&it), parser_context_mismatch)
        CHECK_CBOR_MAP_ERR(cbor_value_get_string_length(&it, &stringLen))
        PARSER_ASSERT_OR_ERROR(stringLen < sizeof(v->paths.paths[index].data), parser_context_unexpected_size)
        CHECK_CBOR_MAP_ERR(_cbor_value_copy_string(&it, v->paths.paths[index].data, &v->paths.paths[index].len, NULL))
        CHECK_CBOR_MAP_ERR(cbor_value_advance(&it));
    }

    while (!cbor_value_at_end(&it)) {
        cbor_value_advance(&it);
    }
    CHECK_CBOR_MAP_ERR(cbor_value_leave_container(&content_paths, &it))

    return parser_ok;
}

parser_error_t readProtobuf(uint8_t *buffer, size_t bufferLen) {
    bool status;

    CHECK_APP_CANARY()
    /* Allocate space for the decoded message. */
    SendRequest request = SendRequest_init_zero;
    CHECK_APP_CANARY()

    /* Create a stream that reads from the buffer. */
    pb_istream_t stream = pb_istream_from_buffer(buffer, bufferLen);
    CHECK_APP_CANARY()

    /* Now we are ready to decode the message. */
    status = pb_decode(&stream, SendRequest_fields, &request);

    CHECK_APP_CANARY()
    /* Check for errors... */
    if (!status) {
        return parser_unexepected_error;
    }

    return parser_ok;
}

parser_error_t readContent(CborValue *content_map, parser_tx_t *v) {
    CborValue content_it;

    PARSER_ASSERT_OR_ERROR(cbor_value_is_container(content_map), parser_unexpected_type)
    CHECK_CBOR_MAP_ERR(cbor_value_enter_container(content_map, &content_it))
    CHECK_CBOR_TYPE(cbor_value_get_type(content_map), CborMapType)

    // Check request type
    READ_STRING(content_map, "request_type", v->request_type)
    if (strcmp(v->request_type.data, PIC("call")) == 0) {
        // Check Size ?
        // TODO:
        v->txtype = 0x00;
        // READ CALL
        READ_STRING(content_map, "sender", v->sender)
        READ_STRING(content_map, "canister_id", v->canister_id)
        READ_STRING(content_map, "nonce", v->nonce)
        READ_STRING(content_map, "method_name", v->method_name)
        READ_INT64(content_map, "ingress_expiry", v->ingress_expiry)
        READ_STRING(content_map, "arg", v->arg)
        //CHECK_PARSER_ERR(readProtobuf(v->arg.data, v->arg.len));

    } else if (strcmp(v->request_type.data, PIC("read_state")) == 0) {
        v->txtype = 0x01;
        READ_STRING(content_map, "sender", v->sender)
        READ_INT64(content_map, "ingress_expiry", v->ingress_expiry)
        CHECK_PARSER_ERR(parsePaths(content_map, v))

    } else if (strcmp(v->request_type.data, PIC("query")) == 0) {
        return parser_unexpected_value;
    } else {
        return parser_unexpected_value;
    }
    // Skip fields until the end
    while (!cbor_value_at_end(&content_it)) {
        cbor_value_advance(&content_it);
    }

    // Exit envelope
    CHECK_CBOR_MAP_ERR(cbor_value_leave_container(content_map, &content_it))

    return parser_ok;
}

parser_error_t _readEnvelope(const parser_context_t *c, parser_tx_t *v) {
    CborValue it;
    INIT_CBOR_PARSER(c, it)
    PARSER_ASSERT_OR_ERROR(!cbor_value_at_end(&it), parser_unexpected_buffer_end)

    // Verify tag
    CHECK_CBOR_TYPE(cbor_value_get_type(&it), CborTagType)
    CborTag tag;
    CHECK_CBOR_MAP_ERR(cbor_value_get_tag(&it, &tag))
    if (tag != 55799) {
        return parser_unexpected_value;
    }
    cbor_value_advance(&it);

    {
        // Enter envelope
        PARSER_ASSERT_OR_ERROR(cbor_value_is_container(&it), parser_unexpected_type)
        PARSER_ASSERT_OR_ERROR(cbor_value_is_map(&it), parser_unexpected_type)

        // check envelope size
        size_t mapLen = 0;
        CHECK_CBOR_MAP_ERR(cbor_value_get_map_length(&it, &mapLen))
        if (mapLen != 3) {
            return parser_unexpected_value;
        }
        CborValue envelope;
        CHECK_CBOR_MAP_ERR(cbor_value_enter_container(&it, &envelope))

        {
            // Enter content
            CborValue content_item;
            CHECK_CBOR_MAP_ERR(cbor_value_map_find_value(&it, "content", &content_item))
            PARSER_ASSERT_OR_ERROR(cbor_value_is_container(&content_item), parser_unexpected_type)
            CHECK_PARSER_ERR(readContent(&content_item, v))
        }

        // Skip fields until the end
        while (!cbor_value_at_end(&envelope)) {
            cbor_value_advance(&envelope);
        }

        // Exit envelope
        CHECK_CBOR_MAP_ERR(cbor_value_leave_container(&it, &envelope))
        // End of buffer does not match end of parsed data
        PARSER_ASSERT_OR_ERROR(it.ptr == c->buffer + c->bufferLen, parser_cbor_unexpected_EOF)
    }

    return parser_ok;
}

parser_error_t _validateTx(const parser_context_t *c, const parser_tx_t *v) {
    // Note: This is place holder for transaction level checks that the project may require before accepting
    // the parsed values. the parser already validates input
    // This function is called by parser_validate, where additional checks are made (formatting, UI/UX, etc.(
    return parser_ok;
}

uint8_t _getNumItems(const parser_context_t *c, const parser_tx_t *v) {
    uint8_t itemCount = 0;
    switch (v->txtype) {
        case 0x00 : {
            itemCount = 7;
            break;
        }
        case 0x01 : {
            itemCount = 3 + v->paths.arrayLen;
            break;
        }
        default : {
            break;
        }
    }

    return itemCount;
}
