import { shellMessages } from "@tc/ui";

export default function Page() {
  return <p>{Object.keys(shellMessages.bn).length}</p>;
}
