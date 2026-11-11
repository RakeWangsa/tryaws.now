import type { ProductFamily } from "@tc/ui";

// Where the order flow sends the customer for a product family that has its own screens: back to the
// form the draft came from, to the page of the new resource, and which entry of the navigation is lit.
// A family that is not here is a server and goes to /servers (the default of the flow). A new family
// adds one row; the pages do not change. `ns` is the message namespace whose `order.open` is the text
// of the button.
export interface FamilyScreen {
  readonly base: string;
  readonly nav: ProductFamily;
  readonly ns: "Cdn" | "Storage" | "Containers";
}

export const FAMILY_SCREENS: Readonly<Record<string, FamilyScreen | undefined>> = {
  cdn: { base: "/cdn", nav: "cdn", ns: "Cdn" },
  bucket: { base: "/storage", nav: "objectStorage", ns: "Storage" },
  container_service: { base: "/containers", nav: "containers", ns: "Containers" },
};

export function familyScreen(family: string | undefined): FamilyScreen | undefined {
  return family !== undefined && Object.hasOwn(FAMILY_SCREENS, family)
    ? FAMILY_SCREENS[family]
    : undefined;
}
