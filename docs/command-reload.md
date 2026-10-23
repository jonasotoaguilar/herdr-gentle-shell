# Command registration after reload

`/herdr-gentle:issues` registers during every extension load, independently of
GitHub authentication and of the Worktree tools setting. Authentication gates
opening the reader, not whether the command exists.

Changing configuration may rebuild Pi's command registry while keeping an
extension module alive. A module-level “already registered” flag therefore
cannot prove that the current runtime has the command. Registration is performed
by the extension entry point on each load; session-start authentication does not
try to register it again later.

The regression test reuses the same module with a new API and then rebuilds the
registry on that API. Both loads must register the command. Interactive reload
still needs verification in the running host; the test establishes the lifecycle
bug without treating a successful unit test as terminal input evidence.
