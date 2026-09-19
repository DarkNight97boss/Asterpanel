"use client";

import { Button } from "./ui";

/** Submit button for plain <form action>, guarded by a native confirm dialog. */
export function ConfirmButton({ message, ...props }: React.ComponentProps<typeof Button> & { message: string }) {
  return <Button type="submit" {...props} onClick={(e) => !window.confirm(message) && e.preventDefault()} />;
}
