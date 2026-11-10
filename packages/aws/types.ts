import type { LightsailClientConfig } from "@aws-sdk/client-lightsail";

/** The transport a client accepts. Production code passes it only from tests. */
export type AwsRequestHandler = NonNullable<LightsailClientConfig["requestHandler"]>;
