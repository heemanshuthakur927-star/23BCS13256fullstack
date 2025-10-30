import React from 'react';
import Product from './components/Product';
import Cart from './components/Cart';
import { products } from './data';

const App = () => {
  return (
    <div style={styles.container}>
      <h1>🛒 Redux Shopping Cart</h1>
      <div style={styles.productList}>
        {products.map(p => (
          <Product key={p.id} product={p} />
        ))}
      </div>
      <Cart />
    </div>
  );
};

const styles = {
  container: {
    textAlign: 'center',
    padding: '20px',
    fontFamily: 'Arial, sans-serif',
  },
  productList: {
    display: 'flex',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
};

export default App;
