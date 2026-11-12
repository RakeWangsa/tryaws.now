import { serializeJsonLd } from "../../../../server/public/seo.ts";

/**
 * One structured-data block. The data is built on the server from fixed fields (server/public/seo.ts)
 * and serialised with every character that could end the block escaped, so `dangerouslySetInnerHTML`
 * carries nothing but that JSON. The block is not executable code, but the policy of U4 wants a
 * nonce on every `<script>`, so it carries the nonce of the request.
 */
export function JsonLd({ data, nonce }: { data: unknown; nonce: string | undefined }) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
