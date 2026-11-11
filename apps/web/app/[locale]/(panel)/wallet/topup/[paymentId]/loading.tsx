import { Card, Skeleton } from "@tc/ui";

/** The final layout of the status page with placeholders in the places of the data (U11). */
export default function PaymentStatusLoading() {
  return (
    <div aria-busy="true">
      <Card className="mb-4">
        <Skeleton lines={5} />
      </Card>
    </div>
  );
}
