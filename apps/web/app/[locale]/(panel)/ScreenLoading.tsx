import { Card, Skeleton } from "@tc/ui";

/** The loading state of a screen (U11): placeholders in the places of the final layout, no spinner. */
export default function ScreenLoading({ lines = [3, 5] }: { lines?: readonly number[] }) {
  return (
    <div aria-busy="true">
      {lines.map((count, index) => (
        <Card key={index} className="mb-4">
          <Skeleton lines={count} />
        </Card>
      ))}
    </div>
  );
}
