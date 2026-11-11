import { expect, it } from "vitest";
import * as aws from "../index";

it("exports exactly the public API and no credentials function", () => {
  expect(Object.keys(aws).sort()).toEqual([
    "AwsError",
    "BOOTSTRAP_EXPECTED_VPC_CIDR",
    "BOOTSTRAP_MARKER_FILE",
    "BOOTSTRAP_OK_MARKER",
    "CALLER_ROLES",
    "LIGHTSAIL_REGIONS",
    "METRIC_RANGES",
    "QUEUE_URL_PATTERN",
    "bootstrapScript",
    "createAwsAccess",
    "createCatalogSource",
    "createLightsailReadSource",
    "createLinuxInstanceAdapter",
    "createSqsClient",
    "createSqsSend",
    "parsePortRules",
    "toAwsError",
    "toLogFields",
  ]);
});
