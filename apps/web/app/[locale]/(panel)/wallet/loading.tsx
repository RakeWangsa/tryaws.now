import { Card, Skeleton } from "@tc/ui";

/** The final layout of /wallet with placeholders in the places of the data (U11). */
export default function WalletLoading() {
  return (
    <div aria-busy="true">
      <div className="row g-3 mb-4">
        <div className="col-12 col-md-6">
          <Card>
            <Skeleton lines={2} />
          </Card>
        </div>
        <div className="col-12 col-md-6">
          <Card>
            <Skeleton lines={2} />
          </Card>
        </div>
      </div>
      <Card className="mb-4">
        <Skeleton lines={5} />
      </Card>
      <Card className="mb-4">
        <Skeleton lines={3} />
      </Card>
    </div>
  );
}
