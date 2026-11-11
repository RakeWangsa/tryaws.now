import { expect, it } from "vitest";
import * as aws from "../index";

it("exports exactly the public API and no credentials function", () => {
  expect(Object.keys(aws).sort()).toEqual([
    "AwsError",
    "CALLER_ROLES",
    "LIGHTSAIL_REGIONS",
    "QUEUE_URL_PATTERN",
    "createAwsAccess",
    "createCatalogSource",
    "createSqsClient",
    "createSqsSend",
    "toAwsError",
    "toLogFields",
  ]);
});
