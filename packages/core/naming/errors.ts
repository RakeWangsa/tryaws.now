export type NamingField =
  "type" | "id" | "input" | "env" | "customerId" | "resourceId" | "orderId" | "os";

const ID_FIELDS: readonly NamingField[] = ["id", "customerId", "resourceId", "orderId"];

/** Thrown for any input the naming functions refuse. The message never contains the refused value. */
export class NamingError extends RangeError {
  readonly field: NamingField;
  constructor(field: NamingField) {
    super(
      ID_FIELDS.includes(field)
        ? `naming: ${field} is not a lowercase UUID`
        : `naming: ${field} is not valid`,
    );
    this.name = "NamingError";
    this.field = field;
  }
}
