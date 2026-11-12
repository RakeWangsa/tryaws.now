import type { invoicesBn } from "./invoices-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const invoicesEn: Same<typeof invoicesBn> = {
  Invoices: {
    meta: { title: "Invoices" },
    heading: "Invoices",
    intro:
      "The invoice of every purchase and renewal is here. TiCON Cloud sells, bills and supports the service.",
    list: {
      caption: "Your invoices",
      number: "Number",
      date: "Date",
      total: "Total",
      view: "View",
      older: "Older invoices",
    },
    empty: {
      title: "No invoices yet",
      body: "After you buy your first server or service, its invoice appears here. The receipt of a wallet top-up is on the wallet page.",
      action: "Open the wallet",
    },
    detail: {
      back: "All invoices",
      title: "Invoice {number}",
      number: "Number",
      date: "Date",
      billedTo: "Billed to",
      noName: "No name given",
      lines: {
        caption: "Lines of the invoice",
        description: "Description",
        amount: "Amount",
        total: "Total",
      },
      print: "Print or save as PDF",
      printHint:
        "The invoice opens on a new page. There, choose “Save as PDF” in the print dialog of your browser.",
      unavailable: {
        title: "This invoice cannot be shown now",
        body: "The lines did not add up to the total, so we stopped instead of showing a wrong amount. Write to support.",
        action: "Write to support",
      },
    },
  },
};
