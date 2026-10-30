package com.idms.workflowreview;

/** One fixed local operation. No SQL, path, PID or arbitrary method input. */
public interface OwnedReaderPeersMBean {
    String exchange(String request) throws Exception;
}
