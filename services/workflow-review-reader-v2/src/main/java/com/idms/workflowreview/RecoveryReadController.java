package com.idms.workflowreview;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class RecoveryReadController {
    private final ReaderRegistry workflow;private final RecoveryCapture capture;
    RecoveryReadController(ReaderRegistry workflow,RecoveryCapture capture){this.workflow=workflow;this.capture=capture;}
    @GetMapping("/v1/recovery-state") Map<String,Object> snapshot(HttpServletRequest request){
        if(request.getQueryString()!=null)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Recovery query parameters are not supported");
        var t=workflow.recoveryTenant(request);String tenant=request.getHeader("X-IDMS-Tenant");
        return workflow.httpRead(()->{
            var tx=new TransactionTemplate(t.tx().getTransactionManager());tx.setReadOnly(true);tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);tx.setTimeout(15);
            return tx.execute(status->capture.capture(t,tenant));
        });
    }
    @GetMapping("/health") Map<String,Object> health(){return Map.of("status","UP","engine","Flowable","version","7.2.0","mode","RECOVERY_READ_ONLY");}
}
