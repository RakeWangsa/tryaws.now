import { Card, Skeleton } from "@tc/ui";

/** The final layout of /wallet/topup with placeholders in the places of the data (U11). */
export default function TopUpLoading() {
  return (
    <div aria-busy="true">
      <Card className="mb-4">
        <Skeleton lines={4} />
      </Card>
      <Card className="mb-4">
        <Skeleton lines={3} />
      </Card>
    </div>
  );
}
