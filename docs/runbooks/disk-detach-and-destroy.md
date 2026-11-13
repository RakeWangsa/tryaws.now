# Disk detach and destroy

Rules: R13 (destructive lifecycle actions need the right subscription state, a final snapshot where supported, and admin approval until 2026-12-01), R16 (fail closed), R10 (every admin action stores actor, reason, IP and target). Source of the stop rule: the Lightsail API reference of `DetachDisk`, read 2026-11-14 (WPU-Z19): "Detaches a stopped block storage disk from a Lightsail instance. Make sure to unmount any file systems on the device within your operating system before stopping the instance and detaching the disk."

## Trigger

- A customer asks why "Detach disk" is refused, or a `detach_disk` operation of a disk is in `needs_attention` with the last error `conflict`.
- A `destroy` operation of a disk (the end of its subscription, or the customer's own destroy) is in `needs_attention` with the last error `conflict`: the disk is still attached to a server that is not stopped.

## Who

Support for the customer contact; operations (`ops` role) for the operation on `/operations`.

## What the platform does

The disk adapter (`packages/aws/adapters/disk.ts`) never stops a server. Detach and destroy of an attached disk read the live state of the server the disk is attached to and go on only when it is `stopped`; any other state, a server that is not found or an answer without a state is a refusal (`conflict`), so the operation stops in `needs_attention` and nothing is deleted (R16). A disk that is not attached is deleted at once by its destroy (`delete_disk`, after its final snapshot where the lifecycle asks for one).

## The order (customer and support)

1. Unmount the filesystem on the server: `sudo umount /data` (the mount point the customer chose), and remove its line from `/etc/fstab`, so the server also boots without the disk.
2. Stop the server in the panel (Servers, the server, Stop) and wait until it shows Stopped.
3. Detach the disk in the panel (Servers, the server, its Block Storage tab), or let the destroy run. Take a snapshot of the disk first if the data matters.
4. Start the server again if it is still needed.

The panel says the same in the Block Storage tab (`apps/web/messages/extras-en.ts`, the detach note). Never detach a mounted disk: data that was not written out is lost.

## End-of-subscription destroy refused because the server runs (operations)

The disk's subscription ended and its destroy was approved (see [lifecycle-approval.md](lifecycle-approval.md)), but the server it is attached to has a subscription of its own and is running.

Safe checks:

1. On `/operations`, the disk's `destroy` is `needs_attention` with `conflict`. The disk's final snapshot (`final_snapshot` of the same disk) is `succeeded`. If it is not, do not go on (R13).
2. The server is the customer's and is running for a reason of its own (its subscription is active). Never stop a customer's server, from the admin app or from the console, to let the destroy pass: that is an outage the customer did not ask for.

Steps:

1. Support writes to the customer (support request or e-mail): the disk's subscription has ended, its data is kept in the final snapshot, and the disk will be removed; please unmount it (`sudo umount <mount point>`, remove the `/etc/fstab` line) and stop the server once, at a time that suits them, or detach the disk in the panel.
2. When the server is stopped (or the disk is detached), `retryOperation` on the disk's `destroy` with a reason (for example "customer stopped the server, ticket <id>"). The destroy detaches the disk, waits for the detach, and deletes it.
3. If the customer does not answer: leave the operation in `needs_attention` and write a Needs decision in JOURNEY.md for the owner (the attached disk keeps costing TiCON its monthly price while it exists). `rejectOperation` on a destroy deletes nothing and only ends the attempt; it is not a way to remove the disk.
4. The server's own end of subscription stops it (suspension), after which a retry of the disk's destroy goes through.

## Rollback

Nothing to undo: a refused detach or destroy changed nothing in AWS. A disk detached by mistake is attached again from the panel (Attach, the same server) while the server is stopped or running.

## What to log

In the support request or ticket: the operation ids, the date the customer was asked, the date the server was stopped, and the reason given with `retryOperation`. Never the customer's data, a key or an account id (R14).

## Must not

- Never stop, reboot or detach anything in the Lightsail console of a pool account by hand.
- Never `rejectOperation` a destroy to "clean up" and never delete the disk in the console.
- Never approve a destroy without the final snapshot where the family has one (R13).
