const GraphQLJSON = require('graphql-type-json');
const {
  resolveAllKeys,
  arrayToObject,
  mapKeys,
  objMerge,
  flatten,
  gqlTypeToString,
} = require('@keystonejs/utils');

const {
  unmergeRelationships,
  createRelationships,
  mergeRelationships,
} = require('./relationship-utils');
const List = require('../List');
const bindSession = require('./session');

const unique = arr => [...new Set(arr)];

const debugGraphQLSchemas = () => !!process.env.DEBUG_GRAPHQL_SCHEMAS;

module.exports = class Keystone {
  constructor(config) {
    this.config = {
      ...config,
    };
    this.defaultAccess = { list: true, field: true, ...config.defaultAccess };
    this.auth = {};
    this.lists = {};
    this.listsArray = [];
    this.getListByKey = key => this.lists[key];
    this.session = bindSession(this);

    if (config.adapters) {
      this.adapters = config.adapters;
      this.defaultAdapter = config.defaultAdapter;
    } else if (config.adapter) {
      this.adapters = { [config.adapter.constructor.name]: config.adapter };
      this.defaultAdapter = config.adapter.constructor.name;
    } else {
      throw new Error('Need an adapter, yo');
    }
  }
  createAuthStrategy(options) {
    const { type: StrategyType, list: listKey, config } = options;
    const { authType } = StrategyType;
    if (!this.auth[listKey]) {
      this.auth[listKey] = {};
    }
    const strategy = new StrategyType(this, listKey, config);
    strategy.authType = authType;
    this.auth[listKey][authType] = strategy;
    return strategy;
  }
  createList(key, config) {
    const { getListByKey, adapters } = this;
    const adapterName = config.adapterName || this.defaultAdapter;
    const list = new List(key, config, {
      getListByKey,
      adapter: adapters[adapterName],
      defaultAccess: this.defaultAccess,
      getAuth: () => this.auth[key],
    });
    this.lists[key] = list;
    this.listsArray.push(list);
  }
  connect(to, options) {
    const {
      adapters,
      config: { name, dbName, adapterConnectOptions },
    } = this;

    Object.values(adapters).forEach(adapter => {
      adapter.connect(
        to,
        {
          name,
          dbName,
          ...adapterConnectOptions,
          ...options,
        }
      );
    });
  }
  getAdminMeta() {
    const { name } = this.config;
    // We've consciously made a design choice that the `read` permission on a
    // list is a master switch in the Admin UI (not the GraphQL API).
    // Justification: If you want to Create without the Read permission, you
    // technically don't have permission to read the result of your creation.
    // If you want to Update an item, you can't see what the current values
    // are. If you want to delete an item, you'd need to be given direct
    // access to it (direct URI), but can't see anything about that item. And
    // in fact, being able to load a page with a 'delete' button on it
    // violates the read permission as it leaks the fact that item exists.
    // In all these cases, the Admin UI becomes unnecessarily complex.
    // So we only allow all these actions if you also have read access.
    const lists = arrayToObject(this.listsArray.filter(list => list.access.read), 'key', list =>
      list.getAdminMeta()
    );

    return { lists, name };
  }

  getTypeDefs() {
    return [
      ...flatten(this.listsArray.map(list => list.getAdminGraphqlTypes())),
      ...[
        {
          comments: [
            'NOTE: Can be JSON, or a Boolean/Int/String',
            "Why not a union? GraphQL doesn't support a union including a scalar",
            '(https://github.com/facebook/graphql/issues/215)',
          ],
          prefix: 'scalar',
          name: 'JSON',
        },
        {
          prefix: 'type',
          name: '_ListAccess',
          args: [
            { comment: `Access Control settings for the currently logged in (or anonymous)` },
            { comment: `user when performing 'create' operations.` },
            { comment: `NOTE: 'create' can only return a Boolean.` },
            { comment: `It is not possible to specify a declarative Where clause for this` },
            { comment: `operation` },
            { name: 'create', type: 'Boolean' },
            { blank: true },
            { comment: `Access Control settings for the currently logged in (or anonymous)` },
            { comment: `user when performing 'read' operations.` },
            { name: 'read', type: 'JSON' },
            { blank: true },
            { comment: `Access Control settings for the currently logged in (or anonymous)` },
            { comment: `user when performing 'update' operations.` },
            { name: 'update', type: 'JSON' },
            { blank: true },
            { comment: `Access Control settings for the currently logged in (or anonymous)` },
            { comment: `user when performing 'delete' operations.` },
            { name: 'delete', type: 'JSON' },
          ],
        },
        {
          prefix: 'type',
          name: '_ListMeta',
          args: [{ name: 'access', type: '_ListAccess' }],
        },
        {
          prefix: 'type',
          name: '_QueryMeta',
          args: [{ name: 'count', type: 'Int' }],
        },
        {
          prefix: 'type',
          name: 'Query',
          args: unique(flatten(this.listsArray.map(list => list.getAdminGraphqlQueries()))),
        },
        {
          prefix: 'type',
          name: 'Mutation',
          args: unique(flatten(this.listsArray.map(list => list.getAdminGraphqlMutations()))),
        },
      ],
    ];
  }

  getAdminSchema() {
    // Fields can be represented multiple times within and between lists.
    // If a field defines a `getGraphqlAuxiliaryTypes()` method, it will be
    // duplicated.
    // graphql-tools will blow up (rightly so) on duplicated types.
    // Deduping here avoids that problem.
    const typeDefs = unique(this.getTypeDefs().map(gqlTypeToString));

    const queryMetaResolver = {
      // meta is passed in from the list's resolver (eg; '_allUsersMeta')
      count: meta => meta.getCount(),
    };

    const listMetaResolver = {
      // meta is passed in from the list's resolver (eg; '_allUsersMeta')
      access: meta => meta.getAccess(),
    };

    const listAccessResolver = {
      // access is passed in from the listMetaResolver
      create: access => access.getCreate(),
      read: access => access.getRead(),
      update: access => access.getUpdate(),
      delete: access => access.getDelete(),
    };

    if (debugGraphQLSchemas()) {
      typeDefs.forEach(i => console.log(i));
    }
    // Like the `typeDefs`, we want to dedupe the resolvers. We rely on the
    // semantics of the JS spread operator here (duplicate keys are overridden
    // - first one wins)
    // TODO: Document this order of precendence, becaut it's not obvious, and
    // there's no errors thrown
    // TODO: console.warn when duplicate keys are detected?
    const resolvers = {
      // Order of spreading is important here - we don't want user-defined types
      // to accidentally override important things like `Query`.
      ...objMerge(this.listsArray.map(list => list.getAuxiliaryTypeResolvers())),
      ...objMerge(this.listsArray.map(list => list.getAdminFieldResolvers())),

      JSON: GraphQLJSON,

      _QueryMeta: queryMetaResolver,
      _ListMeta: listMetaResolver,
      _ListAccess: listAccessResolver,

      Query: {
        // Order is also important here, any TypeQuery's defined by types
        // shouldn't be able to override list-level queries
        ...objMerge(this.listsArray.map(i => i.getAuxiliaryQueryResolvers())),
        ...objMerge(this.listsArray.map(i => i.getAdminQueryResolvers())),
      },

      Mutation: {
        ...objMerge(this.listsArray.map(i => i.getAuxiliaryMutationResolvers())),
        ...objMerge(this.listsArray.map(i => i.getAdminMutationResolvers())),
      },
    };

    if (debugGraphQLSchemas()) {
      console.log(resolvers);
    }

    return { typeDefs, resolvers };
  }

  getListAccessControl({ listKey, operation, authentication }) {
    return this.lists[listKey].getAccessControl({ operation, authentication });
  }

  getFieldAccessControl({ item, listKey, fieldKey, operation, authentication }) {
    return this.lists[listKey].getFieldAccessControl({
      item,
      fieldKey,
      operation,
      authentication,
    });
  }

  createItem(listKey, itemData) {
    return this.lists[listKey].adapter.create(itemData);
  }

  async createItems(itemsToCreate) {
    const createItems = data => {
      return resolveAllKeys(
        mapKeys(data, (value, list) => Promise.all(value.map(item => this.createItem(list, item))))
      );
    };

    const cleanupItems = createdItems =>
      Promise.all(
        Object.keys(createdItems).map(listKey =>
          Promise.all(createdItems[listKey].map(({ id }) => this.lists[listKey].adapter.delete(id)))
        )
      );

    // 1. Split it apart
    const { relationships, data } = unmergeRelationships(this.lists, itemsToCreate);
    // 2. Create the items
    // NOTE: Only works if all relationships fields are non-"required"
    const createdItems = await createItems(data);

    let createdRelationships;
    try {
      // 3. Create the relationships
      createdRelationships = await createRelationships(this.lists, relationships, createdItems);
    } catch (error) {
      // 3.5. If creation of relationships didn't work, unwind the createItems
      cleanupItems(createdItems);
      // Re-throw the error now that we've cleaned up
      throw error;
    }

    // 4. Merge the data back together again
    return mergeRelationships(createdItems, createdRelationships);
  }
};
