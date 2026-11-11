"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

export type SubmitButtonProps = Omit<ButtonProps, "href" | "as" | "type">;

/** A submit Button that is inert while the form it sits in runs its action (U8). */
export function SubmitButton({ pending = false, ...rest }: SubmitButtonProps) {
  const status = useFormStatus();
  return <Button {...rest} type="submit" pending={pending || status.pending} />;
}
