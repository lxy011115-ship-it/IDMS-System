/* Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.idms.workflow;

import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.type.*;
import org.flowable.common.engine.impl.db.FlowableStringTypeHandler;

/** Flowable 8.0.0 JDBC mappings, recompiled against MyBatis 3.6's Type overload.
 * Derived from AbstractEngineConfiguration.initMybatisTypeHandlers in the
 * Apache-2.0 licensed flowable-8.0.0 tag; no vendor binary is modified.
 * Source: https://raw.githubusercontent.com/flowable/flowable-engine/flowable-8.0.0/modules/flowable-engine-common/src/main/java/org/flowable/common/engine/impl/AbstractEngineConfiguration.java
 */
final class WorkflowJdbcMappings {
    private WorkflowJdbcMappings() {}
    static void register(Configuration configuration, String databaseType) {
        // When mapping into Map<String, Object> there is currently a problem with MyBatis.
        // It will return objects which are driver specific.
        // Therefore we are registering the mappings between Object.class and the specific jdbc type here.
        // see https://github.com/mybatis/mybatis-3/issues/2216 for more info
        TypeHandlerRegistry handlerRegistry = configuration.getTypeHandlerRegistry();

        handlerRegistry.register(Object.class, JdbcType.BOOLEAN, new BooleanTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.BIT, new BooleanTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.TINYINT, new ByteTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.SMALLINT, new ShortTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.INTEGER, new IntegerTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.FLOAT, new FloatTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.DOUBLE, new DoubleTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.CHAR, new StringTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.CLOB, new ClobTypeHandler());

        // For SQL server, the performance difference between using varchar or nvarchar is big.
        // Using the correct jdbcType is thus very important for SQL server, but in many mappings the type was not set,
        // which led to defaulting to the regular 'varchar' jdbcType.
        // Up to the point where the following if was added, none of the MyBatis mappings would use 'nvarchar' as jdbcType.
        // Together with this check, all mappings were reviewed and the correct type was added.
        if (databaseType.equals("mssql")) {
            handlerRegistry.register(Object.class, JdbcType.VARCHAR, new StringTypeHandler());
            handlerRegistry.register(String.class, JdbcType.VARCHAR, new StringTypeHandler());
            handlerRegistry.register(Object.class, JdbcType.NVARCHAR, new NStringTypeHandler()); // Notice the 'N' prefix here
            handlerRegistry.register(String.class, JdbcType.NVARCHAR, new NStringTypeHandler()); // Notice the 'N' prefix here
        } else {
            // However, for other databases, we want to keep the old behavior of always using 'varchar',
            // thus the same handler is used for both types.
            handlerRegistry.register(String.class, JdbcType.VARCHAR, new StringTypeHandler());
            handlerRegistry.register(Object.class, JdbcType.VARCHAR, new StringTypeHandler());
            if (databaseType.equals("db2")) {
                handlerRegistry.register(String.class, JdbcType.NVARCHAR, new FlowableStringTypeHandler(true)); // Notice: no 'N' prefix here
                handlerRegistry.register(Object.class, JdbcType.NVARCHAR, new FlowableStringTypeHandler(true)); // Notice: no 'N' prefix here
            } else {
                handlerRegistry.register(String.class, JdbcType.NVARCHAR, new FlowableStringTypeHandler(false)); // Notice: no 'N' prefix here
                handlerRegistry.register(Object.class, JdbcType.NVARCHAR, new FlowableStringTypeHandler(false)); // Notice: no 'N' prefix here
            }
        }

        handlerRegistry.register(Object.class, JdbcType.LONGVARCHAR, new StringTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.NCHAR, new NStringTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.NCLOB, new NClobTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.ARRAY, new ArrayTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.BIGINT, new LongTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.REAL, new BigDecimalTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.DECIMAL, new BigDecimalTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.NUMERIC, new BigDecimalTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.BLOB, new BlobInputStreamTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.LONGVARBINARY, new BlobTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.DATE, new DateOnlyTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.TIME, new TimeOnlyTypeHandler());
        handlerRegistry.register(Object.class, JdbcType.TIMESTAMP, new DateTypeHandler());

        handlerRegistry.register(Object.class, JdbcType.SQLXML, new SqlxmlTypeHandler());
    }

}
