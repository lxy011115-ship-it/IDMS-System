package com.idms.lifecycle;

import java.io.IOException;

/** Tests fixed failure vocabulary only. It neither attaches a JVM nor authorizes a reader operation. */
public final class OwnedReaderPeerAttachDiagnosticQaV1 {
    static final class PrivateDiagnosticQaException extends Exception {
        PrivateDiagnosticQaException(){super("private-fixture-password-not-output");}
    }
    private static void need(boolean value){if(!value)throw new AssertionError("DIAGNOSTIC_CLASSIFIER_QA");}
    public static void main(String[] args){
        need(OwnedReaderPeerAttachV1.safeCode(new IllegalStateException("LIFECYCLE_OWNER")).equals("LIFECYCLE_OWNER"));
        need(OwnedReaderPeerAttachV1.safeCode(new IllegalStateException("private-fixture-password-not-output")).equals("OWNED_READER_PEER_REPLY_UNCONFIRMED"));
        need(OwnedReaderPeerAttachV1.safeCode(new IllegalStateException("LIFECYCLE_PRIVATE_FIXTURE_SECRET")).equals("OWNED_READER_PEER_REPLY_UNCONFIRMED"));
        need(OwnedReaderPeerAttachV1.safeCode(new IOException()).equals("OWNED_READER_PEER_REPLY_UNCONFIRMED"));
        need(OwnedReaderPeerAttachV1.safeType(new IOException("private-fixture-password-not-output")).equals("java.io.IOException"));
        need(OwnedReaderPeerAttachV1.safeType(new PrivateDiagnosticQaException()).equals("java.lang.Exception"));
        System.out.println("{\"format\":\"OWNED_READER_ATTACH_DIAGNOSTIC_CLASSIFIER_QA_V1\",\"checks\":6,\"attachedToAnyJvm\":false,\"rawMessagesPrinted\":false}");
    }
}
