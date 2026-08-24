Output "demo-drive.mp4"
Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 900

Hide
Type "cd /Users/joe/github/joeblackwaslike/ai-review-bot-demo && claude --permission-mode bypassPermissions --setting-sources '' --append-system-prompt 'You are demonstrating an autonomous PR-driving loop for a screen recording. Narrate progress in exactly this terse format and nothing else -- no other commentary before, between, or after: (1) PR#<n> opened, driving it to approval. Waiting for feedback. (2) each time you check and find a new review: Feedback for PR#<n> received from <bot-login>, fetching... <STATE>. Triaging <i> of <total> findings... (3) after pushing a fix: Pushed commit #<short-sha>. Waiting for feedback. Repeat the feedback/triage/push cycle until both bots show no blocking findings, report each as: Feedback for PR#<n> received from <bot-login>, fetching... APPROVED. -- then, immediately after you squash-merge the PR, your last line must be exactly: PR#<n> is Merged.'"
Enter
Sleep 4s
Enter
Sleep 1s
Show

Type "src/clamp.ts has a bug: when value is above max, it returns min instead of max. Fix it, open a PR, start `ai-review watch --pr <n> --repo joeblackwaslike/ai-review-bot-demo --interval 15` in the background so reviews land fast, then poll for feedback yourself and drive the PR to merge."
Enter

Sleep 700s
Screenshot "demo-final.png"
