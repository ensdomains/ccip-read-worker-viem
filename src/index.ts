import type { AbiParametersToPrimitiveTypes } from "abitype";
import {
  error,
  json,
  Router,
  type IRequest,
  type RouterOptions,
} from "itty-router";
import {
  decodeFunctionData,
  encodeFunctionResult,
  isAddress,
  isHex,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
  type Address,
  type Hex,
  type ParseAbiItem,
} from "viem";

type RpcRequest = {
  to: Address;
  data: Hex;
};

type RpcResponse = {
  status: number;
  body: unknown;
};

export type AbiFunctionHandler<abiFunc extends AbiFunction> = (
  args: AbiParametersToPrimitiveTypes<abiFunc["inputs"]>,
  req: RpcRequest
) =>
  | Promise<AbiParametersToPrimitiveTypes<abiFunc["outputs"]>>
  | AbiParametersToPrimitiveTypes<abiFunc["outputs"]>;

type ParseAbiFunction<signature extends string> =
  ParseAbiItem<signature> extends AbiFunction ? ParseAbiItem<signature> : never;

type AddAbiHandlerParameters<signature extends string> = {
  type: signature;
  handle: AbiFunctionHandler<ParseAbiFunction<signature>>;
};

type AbiHandler<abiFunc extends AbiFunction> = {
  type: abiFunc;
  handle: AbiFunctionHandler<abiFunc>;
};

export const CcipRouter = ({
  base,
  before,
  catch: catchFn,
  finally: finallyFn,
}: Pick<RouterOptions, "before" | "catch" | "finally" | "base"> = {}) => {
  const router = Router<IRequest, [], Response>({
    base,
    before,
    catch: catchFn,
    finally: finallyFn,
  });
  const handlers = new Map<Hex, AbiHandler<AbiFunction>>();

  const call = async ({ to, data }: RpcRequest): Promise<RpcResponse> => {
    const selector = data.slice(0, 10).toLowerCase() as Hex;

    // Find a function handler for this selector
    const handler = handlers.get(selector);
    if (!handler)
      return {
        status: 404,
        body: {
          data: {
            error: `No implementation for function with selector ${selector}`,
          },
        },
      };

    // Decode function arguments
    const { args } = decodeFunctionData({ abi: [handler.type], data });

    // Call the handler
    const result = await handler.handle(
      args as AbiParametersToPrimitiveTypes<(typeof handler)["type"]["inputs"]>,
      { to, data }
    );

    // Encode return data
    return {
      status: 200,
      body: {
        data: handler.type.outputs
          ? encodeFunctionResult<readonly [unknown]>({
              abi: [handler.type],
              result: result as readonly unknown[],
            })
          : "0x",
      },
    };
  };

  const handleRequest = async (req: IRequest) => {
    const [sender, callData] =
      req.method === "GET"
        ? [req.params.sender, req.params.callData]
        : await req
            .json<{ sender?: Address; data?: Hex }>()
            .then(({ sender, data }) => [sender, data]);

    if (!sender || !callData || !isAddress(sender) || !isHex(callData))
      return error(400, "Invalid request format");

    try {
      const response = await call({ to: sender, data: callData });
      return json(response.body, { status: response.status });
    } catch (e) {
      return json(
        { data: { error: `Internal server error: ${(e as any).toString()}` } },
        { status: 500 }
      );
    }
  };

  const add = <signature extends string>({
    type,
    handle,
  }: AddAbiHandlerParameters<signature>) => {
    const fn = parseAbiItem(type as string) as AbiFunction;

    const selector = toFunctionSelector(fn);
    if (handlers.has(selector)) throw new Error("Handler already exists");

    handlers.set(selector, {
      type: fn,
      handle: handle as AbiFunctionHandler<AbiFunction>,
    });
  };

  router.get("/:sender/:callData", handleRequest);
  router.post("/", handleRequest);

  return {
    add,
    call,
    fetch: router.fetch,
  };
};
