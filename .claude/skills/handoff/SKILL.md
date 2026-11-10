---
name: handoff
description: End a session cleanly when a task is not finished
disable-model-invocation: true
---
Append a JOURNEY.md entry with: task id, what is done, what is left as a numbered list, the exact
next command to run, open decisions, and the branch name. Commit work in progress on the task
branch with the message "<task id>: wip, see JOURNEY". Push. Do not open a pull request.
